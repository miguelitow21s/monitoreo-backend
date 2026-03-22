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

const endpoint = "auth_register";

const registerEmployeeAction = z.object({
  action: z.literal("register_employee"),
  full_name: z.string().trim().min(2).max(200).optional(),
  first_name: z.string().trim().min(1).max(120).optional(),
  last_name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(5).max(40).optional(),
  email: z.string().email().optional(),
});

const payloadSchema = z.discriminatedUnion("action", [registerEmployeeAction]);

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

    const email = (payload.email ?? authData.user.email ?? "").trim();
    if (!email) {
      throw { code: 422, message: "Email requerido para registro", category: "VALIDATION" };
    }

    const clientUser = createUserClient(token);
    const { error: rpcError } = await clientUser.rpc("register_employee", {
      p_user_id: userId,
      p_email: email,
      p_full_name: payload.full_name ?? null,
      p_first_name: payload.first_name ?? null,
      p_last_name: payload.last_name ?? null,
      p_phone: payload.phone ?? null,
    });

    if (rpcError) {
      throw { code: 409, message: "No se pudo registrar empleado", category: "BUSINESS", details: rpcError };
    }

    const successPayload = { success: true, data: { user_id: userId }, error: null, request_id };
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
