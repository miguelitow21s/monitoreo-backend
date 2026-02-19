import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "jsr:@zod/zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { geoValidatorByShift } from "../_shared/geoValidator.ts";
import { getOwnedShift, ensureShiftState } from "../_shared/stateValidator.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "shifts_end";
const payloadSchema = z.object({
  shift_id: commonSchemas.shiftId,
  lat: commonSchemas.lat,
  lng: commonSchemas.lng,
});

serve(async (req) => {
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
    roleGuard(user, ["empleado"]);

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 20, window_seconds: 60 });

    const { shift_id, lat, lng } = payload;

    const shift = await getOwnedShift(clientUser, user.id, shift_id);
    ensureShiftState(shift.state, ["activo"], "No se puede finalizar este turno");
    await geoValidatorByShift(clientUser, shift_id, lat, lng);

    const { data, error } = await clientUser
      .from("shifts")
      .update({
        end_time: new Date().toISOString(),
        end_lat: lat,
        end_lng: lng,
        state: "finalizado",
        updated_at: new Date().toISOString(),
      })
      .eq("id", shift_id)
      .eq("employee_id", user.id)
      .eq("state", "activo")
      .select("id")
      .single();

    if (error || !data) {
      throw { code: 409, message: "No se pudo finalizar turno", category: "BUSINESS", details: error };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "SHIFT_END",
      context: { shift_id, lat, lng },
      request_id,
    });

    const successPayload = { success: true, data: {}, error: null, request_id };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, {}, null, request_id);
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
