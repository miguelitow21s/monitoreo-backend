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

// Scheduler access: a cron job has no user session, so it authenticates with a
// shared secret instead of a JWT. Disabled entirely (fail closed) when
// CRON_DISPATCH_SECRET isn't configured, and it only ever unlocks THIS endpoint.
const CRON_DISPATCH_SECRET = (Deno.env.get("CRON_DISPATCH_SECRET") ?? "").trim();

function isAuthorizedCronRequest(req: Request): boolean {
  if (CRON_DISPATCH_SECRET.length < 16) return false;
  const provided = (req.headers.get("x-cron-secret") ?? "").trim();
  if (provided.length !== CRON_DISPATCH_SECRET.length) return false;
  // Constant-time comparison so the secret can't be probed byte by byte.
  let diff = 0;
  for (let i = 0; i < CRON_DISPATCH_SECRET.length; i += 1) {
    diff |= CRON_DISPATCH_SECRET.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

const payloadSchema = z.object({
  enqueue_shift_not_started: z.boolean().optional(),
  overdue_limit: z.number().int().min(1).max(500).optional(),
  grace_minutes: z.number().int().min(1).max(240).optional(),
  dispatch_limit: z.number().int().min(1).max(200).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  /** Daily ceiling for queue mail, so the login OTP always has quota left. */
  daily_cap: z.number().int().min(1).max(2000).optional(),
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

    // Two ways in: a super_admin session (manual run) or the scheduler's shared
    // secret. The cron path skips idempotency because every run is a fresh sweep.
    const cronRun = isAuthorizedCronRequest(req);

    if (!cronRun) {
      const { user } = await authGuard(req);
      userId = user.id;
      userRole = user.role;
      roleGuard(user, ["super_admin"]);
    }

    const payload = await parseBody(req, payloadSchema);

    if (cronRun) {
      await rateLimiter({ user_id: "cron-dispatch", ip, endpoint, limit: 30, window_seconds: 60 });
    } else {
      idempotencyKey = requireIdempotencyKey(req);

      const payloadHash = await hashCanonicalJson(payload);
      const claim = await claimIdempotency({ userId: userId as string, endpoint, key: idempotencyKey, payloadHash });
      if (claim.type === "replay") {
        status = claim.stored.status_code;
        return replayIdempotentResponse(claim.stored, request_id);
      }

      await rateLimiter({ user_id: userId as string, ip, endpoint, limit: 15, window_seconds: 60 });
    }

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
      dailyCap: payload.daily_cap,
    });

    const result = {
      queued_shift_not_started: queuedShiftNotStarted,
      attempted: dispatch.attempted,
      sent: dispatch.sent,
      failed: dispatch.failed,
      skipped: dispatch.skipped,
    };

    // Cron runs have no acting user; they're traced through the function logs.
    if (!cronRun && userId) {
      await safeWriteAudit({
        user_id: userId,
        action: "EMAIL_NOTIFICATIONS_DISPATCH",
        context: result,
        request_id,
      });
    }

    const successPayload = { success: true, data: result, error: null, request_id };
    if (!cronRun && userId && idempotencyKey) {
      await safeFinalizeIdempotency({ userId, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
    }

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
