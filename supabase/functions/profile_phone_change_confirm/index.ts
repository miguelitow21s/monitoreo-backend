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
import { hashCanonicalJson, sha256Hex } from "../_shared/crypto.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";

const endpoint = "profile_phone_change_confirm";
const OTP_PURPOSE = "phone_change";
const E164_PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;

const payloadSchema = z.object({
  new_phone: z.string().trim().min(6).max(20),
  code: z.string().trim().regex(/^\d{6}$/, "El codigo debe tener 6 digitos"),
});

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

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 10, window_seconds: 60 });

    const newPhone = payload.new_phone.trim();
    if (!E164_PHONE_REGEX.test(newPhone)) {
      throw {
        code: 422,
        error_code: "PHONE_FORMAT_INVALID",
        message: "Numero invalido. Usa formato internacional E.164 (ej. +13235550123)",
        category: "VALIDATION",
      };
    }
    const code = payload.code.trim();

    // Latest pending phone-change code for this user.
    const { data: otp, error: otpError } = await clientAdmin
      .from("user_phone_otps")
      .select("id, phone_e164, code_hash, expires_at, attempts, max_attempts")
      .eq("user_id", user.id)
      .eq("purpose", OTP_PURPOSE)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (otpError) {
      throw { code: 500, message: "No se pudo consultar el codigo", category: "SYSTEM", details: otpError };
    }
    if (!otp) {
      throw { code: 409, error_code: "INVALID_CODE", message: "No hay un cambio de numero pendiente. Solicita uno nuevo", category: "BUSINESS" };
    }

    const nowIso = new Date().toISOString();
    const otpExpires = new Date(otp.expires_at as string).getTime();
    if (!Number.isFinite(otpExpires) || otpExpires <= Date.now()) {
      await clientAdmin.from("user_phone_otps").update({ consumed_at: nowIso, updated_at: nowIso }).eq("id", otp.id);
      throw { code: 409, error_code: "CODE_EXPIRED", message: "El codigo expiro. Solicita uno nuevo", category: "BUSINESS" };
    }

    if ((otp.attempts as number) >= (otp.max_attempts as number)) {
      await clientAdmin.from("user_phone_otps").update({ consumed_at: nowIso, updated_at: nowIso }).eq("id", otp.id);
      throw { code: 409, error_code: "INVALID_CODE", message: "Codigo bloqueado por demasiados intentos. Solicita uno nuevo", category: "BUSINESS" };
    }

    // The code was issued for a specific target number; it can't authorize another.
    if (String(otp.phone_e164 ?? "") !== newPhone) {
      throw { code: 409, error_code: "INVALID_CODE", message: "El codigo no corresponde a este numero. Solicita uno nuevo", category: "BUSINESS" };
    }

    const providedHash = await hashPhoneOtp(user.id, code);
    if (providedHash !== (otp.code_hash as string)) {
      const attempts = (otp.attempts as number) + 1;
      const maxAttempts = otp.max_attempts as number;
      const consume = attempts >= maxAttempts;
      await clientAdmin
        .from("user_phone_otps")
        .update({ attempts, consumed_at: consume ? nowIso : null, updated_at: nowIso })
        .eq("id", otp.id);
      throw {
        code: 422,
        error_code: "INVALID_CODE",
        message: "Codigo incorrecto",
        category: "VALIDATION",
        details: { remaining_attempts: Math.max(0, maxAttempts - attempts) },
      };
    }

    // Re-check the number is still free (a race since the request was issued).
    const { data: taken } = await clientAdmin
      .from("users")
      .select("id")
      .eq("phone_e164", newPhone)
      .neq("id", user.id)
      .limit(1)
      .maybeSingle();
    if (taken?.id) {
      throw { code: 409, error_code: "PHONE_ALREADY_IN_USE", message: "Ese numero ya esta en uso por otra cuenta", category: "BUSINESS" };
    }

    // Consume the code, then persist. Consume first so a retry can't reuse it.
    const { error: consumeError } = await clientAdmin
      .from("user_phone_otps")
      .update({ consumed_at: nowIso, updated_at: nowIso })
      .eq("id", otp.id)
      .is("consumed_at", null);
    if (consumeError) {
      throw { code: 500, message: "No se pudo consumir el codigo", category: "SYSTEM", details: consumeError };
    }

    const { error: updateError } = await clientAdmin
      .from("users")
      .update({ phone_e164: newPhone, updated_at: nowIso })
      .eq("id", user.id);
    if (updateError) {
      throw { code: 409, message: "No se pudo actualizar el numero", category: "BUSINESS", details: updateError };
    }

    // Mirror into auth.users.phone so future SMS OTPs use the new number. GoTrue
    // stores it digits-only. Best-effort: the app's source of truth is the profile
    // row, so a GoTrue quirk must not undo a change the user already confirmed.
    let auth_synced = true;
    try {
      const { error: authError } = await clientAdmin.auth.admin.updateUserById(user.id, { phone: newPhone.replace(/^\+/, "") });
      if (authError) auth_synced = false;
    } catch (_e) {
      auth_synced = false;
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "PROFILE_PHONE_CHANGE_CONFIRM",
      context: { otp_id: otp.id, auth_synced },
      request_id,
    });

    const result = { ok: true, phone: newPhone, auth_synced };
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
