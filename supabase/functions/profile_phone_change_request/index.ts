// @ts-nocheck
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
import { hashCanonicalJson, randomNumericCode, sha256Hex } from "../_shared/crypto.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { sendPhoneChangeOtpEmail } from "../_shared/emailNotifications.ts";

const endpoint = "profile_phone_change_request";
const OTP_PURPOSE = "phone_change";
const E164_PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;
const TTL_SECONDS = 600; // 10 minutes

const payloadSchema = z.object({
  new_phone: z.string().trim().min(6).max(20),
});

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const masked = local.length <= 2 ? "***" : `${local[0]}***${local.slice(-1)}`;
  return `${masked}${email.slice(at)}`;
}

// A code emailed to authorize a phone change is hashed exactly like the login OTP
// (same pepper), so both go through one hashing scheme.
async function hashPhoneOtp(userId: string, code: string): Promise<string> {
  const pepper = Deno.env.get("OTP_HASH_PEPPER") ?? "";
  return sha256Hex(`${userId}:${code}:${pepper}`);
}

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

    // Tight limit: 3 requests / 10 min, so the emailed code can't be spammed.
    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 3, window_seconds: TTL_SECONDS });

    const newPhone = payload.new_phone.trim();
    if (!E164_PHONE_REGEX.test(newPhone)) {
      throw {
        code: 422,
        error_code: "PHONE_FORMAT_INVALID",
        message: "Numero invalido. Usa formato internacional E.164 (ej. +13235550123)",
        category: "VALIDATION",
      };
    }

    // Only ever the caller's own account.
    const { data: me, error: meError } = await clientAdmin
      .from("users")
      .select("id, email, phone_e164")
      .eq("id", user.id)
      .maybeSingle();
    if (meError || !me) {
      throw { code: 404, message: "Usuario no encontrado", category: "BUSINESS", details: meError };
    }

    const email = String((me as { email?: string | null }).email ?? "").trim();
    if (!email) {
      throw { code: 409, error_code: "NO_ACCOUNT_EMAIL", message: "Tu cuenta no tiene correo para enviar el codigo", category: "BUSINESS" };
    }

    // No-op if the number isn't actually changing.
    if (String((me as { phone_e164?: string | null }).phone_e164 ?? "") === newPhone) {
      const noopPayload = { success: true, data: { ok: true, noop: true, phone: newPhone }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: noopPayload });
      return response(true, noopPayload.data, null, request_id);
    }

    // Reject a number already taken by someone else before we bother emailing.
    const { data: taken, error: takenError } = await clientAdmin
      .from("users")
      .select("id")
      .eq("phone_e164", newPhone)
      .neq("id", user.id)
      .limit(1)
      .maybeSingle();
    if (takenError) {
      throw { code: 500, message: "No se pudo validar el numero", category: "SYSTEM", details: takenError };
    }
    if (taken?.id) {
      throw { code: 409, error_code: "PHONE_ALREADY_IN_USE", message: "Ese numero ya esta en uso por otra cuenta", category: "BUSINESS" };
    }

    const code = randomNumericCode(6);
    const emailResult = await sendPhoneChangeOtpEmail({ to: email, code, ttlSeconds: TTL_SECONDS, newPhone });
    if (!emailResult.ok) {
      throw {
        code: 503,
        error_code: "EMAIL_SEND_FAILED",
        message: "No se pudo enviar el codigo por email",
        category: "SYSTEM",
        details: { error: emailResult.error },
      };
    }

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000).toISOString();
    const codeHash = await hashPhoneOtp(user.id, code);

    // Only one active phone-change code at a time.
    await clientAdmin
      .from("user_phone_otps")
      .update({ consumed_at: nowIso, updated_at: nowIso })
      .eq("user_id", user.id)
      .eq("purpose", OTP_PURPOSE)
      .is("consumed_at", null);

    const { data: otpRow, error: otpError } = await clientAdmin
      .from("user_phone_otps")
      .insert({
        user_id: user.id,
        // The target number is bound to the code, so confirm can't apply it to another.
        phone_e164: newPhone,
        purpose: OTP_PURPOSE,
        code_hash: codeHash,
        expires_at: expiresAt,
        max_attempts: 5,
        attempts: 0,
        delivery_status: "sent",
        provider_ref: emailResult.provider_ref ?? null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .single();
    if (otpError || !otpRow?.id) {
      throw { code: 500, message: "No se pudo crear el codigo de cambio", category: "SYSTEM", details: otpError };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "PROFILE_PHONE_CHANGE_REQUEST",
      context: { otp_id: otpRow.id, expires_at: expiresAt },
      request_id,
    });

    const result = { ok: true, delivery: "email", expires_at: expiresAt, masked_email: maskEmail(email) };
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
