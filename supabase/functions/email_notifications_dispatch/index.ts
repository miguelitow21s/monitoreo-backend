import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";
import { dispatchPendingEmailNotifications, enqueueOverdueShiftNotStartedNotifications } from "../_shared/emailNotifications.ts";

const endpoint = "email_notifications_dispatch";

const payloadSchema = z.object({
  enqueue_shift_not_started: z.boolean().optional(),
  overdue_limit: z.number().int().min(1).max(500).optional(),
  grace_minutes: z.number().int().min(1).max(240).optional(),
  dispatch_limit: z.number().int().min(1).max(200).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
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
    roleGuard(user, ["super_admin"]);

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 15, window_seconds: 60 });

    const shouldEnqueue = payload.enqueue_shift_not_started ?? true;

    let queuedShiftNotStarted = 0;
    if (shouldEnqueue) {
      queuedShiftNotStarted = await enqueueOverdueShiftNotStartedNotifications({
        limit: payload.overdue_limit,
        graceMinutes: payload.grace_minutes,
      });
    }

    const dispatch = await dispatchPendingEmailNotifications({
      limit: payload.dispatch_limit,
      maxAttempts: payload.max_attempts,
    });

    const result = {
      queued_shift_not_started: queuedShiftNotStarted,
      attempted: dispatch.attempted,
      sent: dispatch.sent,
      failed: dispatch.failed,
      skipped: dispatch.skipped,
    };

    await safeWriteAudit({
      user_id: user.id,
      action: "EMAIL_NOTIFICATIONS_DISPATCH",
      context: result,
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
