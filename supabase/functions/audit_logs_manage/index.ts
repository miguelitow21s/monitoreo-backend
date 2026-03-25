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

const endpoint = "audit_logs_manage";

const listAction = z.object({
  action: z.literal("list"),
  limit: z.number().int().min(1).max(1000).default(200),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  search: z.string().trim().min(1).max(200).optional(),
  action_filter: z.string().trim().min(1).max(200).optional(),
  action_name: z.string().trim().min(1).max(200).optional(),
  endpoint: z.string().trim().min(1).max(200).optional(),
  user_id: z.string().uuid().optional(),
  request_id: z.string().uuid().optional(),
});

const payloadSchema = z.discriminatedUnion("action", [listAction]);

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

    if ((payload.from && !payload.to) || (!payload.from && payload.to)) {
      throw { code: 422, message: "from y to son requeridos juntos", category: "VALIDATION" };
    }

    let query = clientAdmin
      .from("audit_logs")
      .select("id, user_id, action, context, request_id, created_at")
      .order("created_at", { ascending: false })
      .limit(payload.limit);

    if (payload.from && payload.to) {
      query = query.gte("created_at", payload.from).lte("created_at", payload.to);
    }

    if (payload.user_id) query = query.eq("user_id", payload.user_id);
    if (payload.request_id) query = query.eq("request_id", payload.request_id);
    const actionFilter = payload.action_filter ?? payload.action_name;
    if (actionFilter) query = query.eq("action", actionFilter);

    if (payload.endpoint) {
      query = query.eq("context->>endpoint", payload.endpoint);
    }

    const searchRaw = payload.search?.trim();
    if (searchRaw) {
      const term = searchRaw.replace(/,/g, " ");
      query = query.or(`action.ilike.%${term}%,context.ilike.%${term}%`);
    }

    const { data: logs, error: logsError } = await query;

    if (logsError) {
      throw { code: 409, message: "No se pudieron cargar auditorias", category: "BUSINESS", details: logsError };
    }

    const successPayload = { success: true, data: { items: logs ?? [] }, error: null, request_id };
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
