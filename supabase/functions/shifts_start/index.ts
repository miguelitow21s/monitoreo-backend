import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { geoValidatorByRestaurant } from "../_shared/geoValidator.ts";
import { ensureNoActiveShift } from "../_shared/stateValidator.ts";
import { ensureSupervisorRestaurantAccess } from "../_shared/scopeGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";
import { requireTrustedDevice } from "../_shared/deviceTrust.ts";
import { requireShiftOtpSession } from "../_shared/otp.ts";
import { notifyShiftEvent, safeDispatchPendingEmailNotifications } from "../_shared/emailNotifications.ts";

const endpoint = "shifts_start";
const payloadSchema = z.object({
  restaurant_id: commonSchemas.restaurantId,
  lat: commonSchemas.lat,
  lng: commonSchemas.lng,
  fit_for_work: z.boolean(),
  declaration: z.string().trim().max(500).optional().nullable(),
});

serve(async (req) => {
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
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["empleado", "supervisora"]);
    await requireAcceptedActiveLegalTerm(user.id);
    const trustedDevice = await requireTrustedDevice({ userId: user.id, req });
    await requireShiftOtpSession({ req, userId: user.id, trustedDeviceId: trustedDevice.id });

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 20, window_seconds: 60 });

    const { restaurant_id, lat, lng, fit_for_work, declaration } = payload;

    await ensureNoActiveShift(clientUser, user.id);
    if (user.role === "supervisora") {
      await ensureSupervisorRestaurantAccess(user.id, restaurant_id);
    }
    await geoValidatorByRestaurant(clientUser, restaurant_id, lat, lng);

    const { data, error } = await clientUser
      .from("shifts")
      .insert({
        employee_id: user.id,
        restaurant_id,
        start_time: new Date().toISOString(),
        start_lat: lat,
        start_lng: lng,
        state: "activo",
      })
      .select("id")
      .single();

    if (error || !data) {
      throw { code: 409, message: "No se pudo iniciar turno", category: "BUSINESS", details: error };
    }

    const { error: healthError } = await clientUser
      .from("shift_health_forms")
      .upsert(
        {
          shift_id: data.id,
          phase: "start",
          fit_for_work,
          declaration: declaration ?? null,
          recorded_at: new Date().toISOString(),
          recorded_by: user.id,
        },
        { onConflict: "shift_id,phase" }
      );

    if (healthError) {
      throw { code: 409, message: "No se pudo registrar formulario de ingreso", category: "BUSINESS", details: healthError };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "SHIFT_START",
      context: { shift_id: data.id, restaurant_id, lat, lng, fit_for_work },
      request_id,
    });

    await notifyShiftEvent({
      eventType: "shift_started",
      shiftId: data.id,
      actorUserId: user.id,
    });
    await safeDispatchPendingEmailNotifications({ limit: 25, maxAttempts: 5 });

    const { data: openTasks, error: openTasksError } = await clientUser
      .from("operational_tasks")
      .select("id, title, priority, due_at")
      .eq("assigned_employee_id", user.id)
      .in("status", ["pending", "in_progress"])
      .order("updated_at", { ascending: false })
      .limit(10);

    if (openTasksError) {
      throw { code: 409, message: "No se pudieron cargar alertas de tareas", category: "BUSINESS", details: openTasksError };
    }

    const successData = {
      shift_id: data.id,
      pending_tasks_count: (openTasks ?? []).length,
      pending_tasks_preview: openTasks ?? [],
    };
    const successPayload = { success: true, data: successData, error: null, request_id };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, successData, null, request_id);
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

