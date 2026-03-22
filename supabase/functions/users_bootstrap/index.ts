// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { clientAdmin, createUserClient } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "users_bootstrap";

const bootstrapAction = z.object({
  action: z.literal("bootstrap_my_user"),
});

const payloadSchema = z.discriminatedUnion("action", [bootstrapAction]);

function readToken(req: Request): string {
  const authHeader = req.headers.get("Authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const rawAuth = (bearerMatch?.[1] ?? authHeader).trim();
  if (!rawAuth || rawAuth.toLowerCase() === "undefined" || rawAuth.toLowerCase() === "null") {
    throw { code: 401, message: "No autenticado", category: "AUTH" };
  }
  return rawAuth;
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
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const token = readToken(req);
    const { data: authData, error: authError } = await clientAdmin.auth.getUser(token);
    if (authError || !authData?.user?.id) {
      throw { code: 401, message: "Sesion invalida", category: "AUTH", details: authError };
    }
    userId = authData.user.id;

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: userId, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: userId, ip, endpoint, limit: 10, window_seconds: 60 });

    const clientUser = createUserClient(token);
    const { data, error: rpcError } = await clientUser.rpc("bootstrap_my_user");
    if (rpcError) {
      throw { code: 409, message: "No se pudo ejecutar bootstrap", category: "BUSINESS", details: rpcError };
    }

    const successPayload = { success: true, data: data ?? {}, error: null, request_id };
    await safeFinalizeIdempotency({ userId: userId, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
    return response(true, successPayload.data, null, request_id);
  } catch (err) {
    const apiError = errorHandler(err, request_id);
    status = apiError.code;
    error_code = apiError.category;

    if (userId && idempotencyKey) {
      const failPayload = { success: false, data: null, error: apiError, request_id };
      await safeFinalizeIdempotency({ userId: userId, endpoint, key: idempotencyKey, statusCode: apiError.code, responseBody: failPayload });
    }

    return response(false, null, apiError, request_id);
  } finally {
    logRequest({
      request_id,
      endpoint,
      method: req.method,
      ip,
      user_agent: userAgent,
      user: userId ? { id: userId } : undefined,
      duration_ms: Date.now() - startedAt,
      status,
      error_code,
    });
  }
});
