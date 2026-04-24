import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";
import { getTrustedDeviceStatus } from "../_shared/deviceTrust.ts";

const endpoint = "trusted_device_validate";

const payloadSchema = z.object({
  device_fingerprint: z.string().trim().min(16).max(256).optional(),
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
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 60, window_seconds: 60 });

    let result: {
      trusted: boolean;
      first_login_binding: boolean;
      registration_required: boolean;
      trusted_devices_count: number;
      device_id: number | null;
      trusted_at: string | null;
      last_seen_at: string | null;
    };

    if (user.role === "super_admin") {
      result = {
        trusted: true,
        first_login_binding: false,
        registration_required: false,
        trusted_devices_count: 0,
        device_id: null,
        trusted_at: null,
        last_seen_at: null,
      };
    } else {
      const trusted = await getTrustedDeviceStatus({
        userId: user.id,
        req,
        bodyFingerprint: payload.device_fingerprint,
      });

      result = {
        trusted: trusted.trusted,
        first_login_binding: trusted.first_login_binding,
        registration_required: !trusted.trusted,
        trusted_devices_count: trusted.trusted_devices_count,
        device_id: trusted.device?.id ?? null,
        trusted_at: trusted.device?.trusted_at ?? null,
        last_seen_at: trusted.device?.last_seen_at ?? null,
      };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "DEVICE_TRUST_VALIDATE",
      context: {
        trusted: result.trusted,
        first_login_binding: result.first_login_binding,
        registration_required: result.registration_required,
        trusted_devices_count: result.trusted_devices_count,
        device_id: result.device_id,
      },
      request_id,
    });

    const successPayload = { success: true, data: result, error: null, request_id };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, result, null, request_id);
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
