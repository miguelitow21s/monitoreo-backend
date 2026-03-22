// @ts-nocheck
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
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "reports_manage";

const listShiftsAction = z.object({
  action: z.literal("list_shifts"),
  from: z.string().min(8),
  to: z.string().min(8),
  restaurant_id: z.number().int().positive().optional(),
  employee_id: z.string().uuid().optional(),
  supervisor_id: z.string().uuid().optional(),
  status: z.enum(["activo", "finalizado", "aprobado", "rechazado"]).optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});

const listHistoryAction = z.object({
  action: z.literal("list_history"),
  limit: z.number().int().min(1).max(500).default(100),
});

const payloadSchema = z.discriminatedUnion("action", [listShiftsAction, listHistoryAction]);

function toFromIso(value: string) {
  if (value.includes("T")) return value;
  return `${value}T00:00:00.000Z`;
}

function toToIso(value: string) {
  if (value.includes("T")) return value;
  return `${value}T23:59:59.999Z`;
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

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 30, window_seconds: 60 });

    if (payload.action === "list_history") {
      const { data: history, error: historyError } = await clientAdmin
        .from("reports")
        .select("id, restaurant_id, period_start, period_end, generated_by, url_pdf, url_excel, created_at")
        .order("created_at", { ascending: false })
        .limit(payload.limit);

      if (historyError) {
        throw { code: 409, message: "No se pudo listar historial de reportes", category: "BUSINESS", details: historyError };
      }

      const successPayload = { success: true, data: { items: history ?? [] }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    const fromIso = toFromIso(payload.from);
    const toIso = toToIso(payload.to);

    let query = clientAdmin
      .from("shifts")
      .select("id, employee_id, restaurant_id, start_time, end_time, state, approved_by, rejected_by")
      .gte("start_time", fromIso)
      .lte("start_time", toIso)
      .order("start_time", { ascending: false })
      .limit(payload.limit);

    if (payload.restaurant_id) query = query.eq("restaurant_id", payload.restaurant_id);
    if (payload.employee_id) query = query.eq("employee_id", payload.employee_id);
    if (payload.status) query = query.eq("state", payload.status);
    if (payload.supervisor_id) {
      const supId = payload.supervisor_id;
      query = query.or(`approved_by.eq.${supId},rejected_by.eq.${supId}`);
    }

    const { data: shifts, error: shiftsError } = await query;
    if (shiftsError) {
      throw { code: 409, message: "No se pudieron listar turnos", category: "BUSINESS", details: shiftsError };
    }

    const successPayload = { success: true, data: { items: shifts ?? [] }, error: null, request_id };
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
