import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "system_settings_manage";

const getAction = z.object({
  action: z.literal("get"),
});

const updateAction = z.object({
  action: z.literal("update"),
  settings: z.record(z.any()),
});

const payloadSchema = z.discriminatedUnion("action", [getAction, updateAction]);

const defaultSettings = {
  security: {
    pin_length: 6,
    force_password_change_on_first_login: false,
    otp_expiration_minutes: 10,
    trusted_device_days: 30,
  },
  legal: {
    consent_text: "Autorizo el uso de mis datos personales, ubicacion GPS y camara para fines de verificacion de turnos laborales.",
    support_email: "soporte@worktrace.com",
  },
  gps: {
    default_radius_meters: 100,
    min_accuracy_meters: 100,
    require_gps_for_shift_start: true,
    require_gps_for_supervision: true,
  },
  shifts: {
    default_hours: 6,
    min_hours: 1,
    max_hours: 12,
    early_start_tolerance_minutes: 30,
    late_start_tolerance_minutes: 30,
  },
  evidence: {
    require_start_photos: true,
    require_end_photos: true,
    require_supervision_photos: true,
    default_cleaning_areas: ["Cocina", "Comedor", "Banos", "Patio"],
    areas_mode: "restaurant_or_default",
  },
  tasks: {
    require_special_task_completion_check: true,
    require_special_task_notes: true,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeDeep(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function ensureSettingsRow(): Promise<Record<string, unknown>> {
  const { data, error } = await clientAdmin
    .from("system_settings")
    .select("id, settings")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw { code: 500, message: "No se pudo cargar configuracion", category: "SYSTEM", details: error };
  }

  if (data?.settings) {
    return data.settings as Record<string, unknown>;
  }

  const { error: insertError } = await clientAdmin
    .from("system_settings")
    .insert({ id: 1, settings: defaultSettings })
    .eq("id", 1);

  if (insertError) {
    throw { code: 500, message: "No se pudo inicializar configuracion", category: "SYSTEM", details: insertError };
  }

  return defaultSettings as Record<string, unknown>;
}

serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const request_id = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  let status = 200;
  let error_code: string | undefined;
  let userId: string | undefined;
  let userRole: "super_admin" | "supervisora" | "empleado" | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 20, window_seconds: 60 });

    if (payload.action === "get") {
      const settings = await ensureSettingsRow();
      const successPayload = { success: true, data: { settings }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    const current = await ensureSettingsRow();
    const merged = mergeDeep(current, payload.settings ?? {});

    const { data, error } = await clientAdmin
      .from("system_settings")
      .update({ settings: merged, updated_at: new Date().toISOString(), updated_by: user.id })
      .eq("id", 1)
      .select("settings")
      .single();

    if (error || !data?.settings) {
      throw { code: 500, message: "No se pudo actualizar configuracion", category: "SYSTEM", details: error };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "SYSTEM_SETTINGS_UPDATE",
      context: { updated_by: user.id },
      request_id,
    });

    const successPayload = { success: true, data: { settings: data.settings }, error: null, request_id };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
    return response(true, successPayload.data, null, request_id);
  } catch (err) {
    const apiError = errorHandler(err, request_id);
    status = apiError.code;
    error_code = apiError.category;

    if (userId && idempotencyKey) {
      const failPayload = { success: false, data: null, error: apiError, request_id };
      await safeFinalizeIdempotency({ userId, endpoint, key: idempotencyKey, statusCode: apiError.code, responseBody: failPayload });
    }

    return response(false, null, apiError, request_id);
  } finally {
    logRequest({
      request_id,
      endpoint,
      method: req.method,
      ip,
      user_agent: userAgent,
      user: userId && userRole ? { id: userId, role: userRole } : undefined,
      duration_ms: Date.now() - startedAt,
      status,
      error_code,
    });
  }
});
