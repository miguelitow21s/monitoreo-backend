import { clientAdmin } from "./supabaseClient.ts";
import { randomNumericCode, randomTokenHex, sha256Hex } from "./crypto.ts";
import { sendOtpEmail } from "./emailNotifications.ts";

const OTP_PURPOSE = "shift_ops";

function parseEnvInt(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envIsTrue(name: string): boolean {
  return (Deno.env.get(name) ?? "").trim().toLowerCase() === "true";
}

function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "***";
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const masked = local.length <= 2 ? "***" : `${local[0]}***${local.slice(-1)}`;
  return `${masked}${domain}`;
}

async function hashOtpCode(userId: string, code: string): Promise<string> {
  const pepper = Deno.env.get("OTP_HASH_PEPPER") ?? "";
  return sha256Hex(`${userId}:${code}:${pepper}`);
}

export async function issueShiftOtp(params: {
  userId: string;
}): Promise<{
  otp_id: number;
  expires_at: string;
  masked_email: string;
  delivery_status: "sent" | "debug" | "screen";
  debug_code?: string;
}> {
  const ttlSeconds = parseEnvInt("OTP_TTL_SECONDS", 300);
  const debugMode = envIsTrue("OTP_DEBUG_MODE");
  const screenMode = envIsTrue("OTP_SCREEN_MODE");

  let userEmail: string | null = null;
  if (!screenMode) {
    const { data: userRow, error: userError } = await clientAdmin
      .from("users")
      .select("email")
      .eq("id", params.userId)
      .maybeSingle();

    if (userError || !userRow) {
      throw { code: 404, message: "Usuario no encontrado", category: "BUSINESS" };
    }

    userEmail = (userRow as { email?: string | null })?.email?.trim() || null;
    if (!userEmail) {
      throw { code: 409, message: "Usuario sin correo registrado", category: "BUSINESS" };
    }
  }

  const code = randomNumericCode(6);

  let deliveryStatus: "sent" | "debug" | "screen";
  if (screenMode) {
    deliveryStatus = "screen";
  } else {
    const emailResult = await sendOtpEmail({ to: userEmail!, code, ttlSeconds });
    if (emailResult.ok) {
      deliveryStatus = "sent";
    } else if (emailResult.error === "provider_not_configured" && debugMode) {
      deliveryStatus = "debug";
    } else if (emailResult.error === "provider_not_configured") {
      throw {
        code: 503,
        message: "Proveedor de email no configurado",
        category: "SYSTEM",
        details: { required_env: ["RESEND_API_KEY", "EMAIL_FROM"] },
      };
    } else {
      throw {
        code: 503,
        message: "No se pudo enviar codigo de acceso por email",
        category: "SYSTEM",
        details: { error: emailResult.error },
      };
    }
  }

  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const codeHash = await hashOtpCode(params.userId, code);

  const { error: invalidateError } = await clientAdmin
    .from("user_phone_otps")
    .update({ consumed_at: nowIso, updated_at: nowIso })
    .eq("user_id", params.userId)
    .eq("purpose", OTP_PURPOSE)
    .is("consumed_at", null);

  if (invalidateError) {
    throw { code: 500, message: "No se pudo invalidar OTP anterior", category: "SYSTEM", details: invalidateError };
  }

  const { data, error } = await clientAdmin
    .from("user_phone_otps")
    .insert({
      user_id: params.userId,
      phone_e164: null,
      purpose: OTP_PURPOSE,
      code_hash: codeHash,
      expires_at: expiresAt,
      max_attempts: 5,
      attempts: 0,
      delivery_status: deliveryStatus,
      provider_ref: null,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw { code: 500, message: "No se pudo crear OTP", category: "SYSTEM", details: error };
  }

  const result: {
    otp_id: number;
    expires_at: string;
    masked_email: string;
    delivery_status: "sent" | "debug" | "screen";
    debug_code?: string;
  } = {
    otp_id: data.id as number,
    expires_at: expiresAt,
    masked_email: userEmail ? maskEmail(userEmail) : "OTP en pantalla",
    delivery_status: deliveryStatus,
  };

  const isProduction = (Deno.env.get("ENVIRONMENT") ?? "").toLowerCase() === "production";
  if ((debugMode || screenMode) && !isProduction) {
    result.debug_code = code;
  }

  return result;
}

export async function verifyShiftOtpCode(params: {
  userId: string;
  code: string;
  trustedDeviceId: number;
}): Promise<{ verification_token: string; expires_at: string }> {
  const code = params.code.trim();
  if (!/^\d{6}$/.test(code)) {
    throw { code: 422, message: "Codigo de acceso invalido", category: "VALIDATION" };
  }

  const { data: otp, error: otpError } = await clientAdmin
    .from("user_phone_otps")
    .select("id, code_hash, expires_at, attempts, max_attempts")
    .eq("user_id", params.userId)
    .eq("purpose", OTP_PURPOSE)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (otpError) {
    throw { code: 500, message: "No se pudo consultar OTP", category: "SYSTEM", details: otpError };
  }

  if (!otp) {
    throw { code: 409, message: "No hay codigo de acceso activo", category: "BUSINESS" };
  }

  const now = Date.now();
  const otpExpires = new Date(otp.expires_at as string).getTime();
  if (!Number.isFinite(otpExpires) || otpExpires <= now) {
    await clientAdmin.from("user_phone_otps").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id as number);
    throw { code: 409, message: "Codigo de acceso expirado", category: "BUSINESS" };
  }

  if ((otp.attempts as number) >= (otp.max_attempts as number)) {
    await clientAdmin.from("user_phone_otps").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id as number);
    throw { code: 409, message: "Codigo de acceso bloqueado por demasiados intentos", category: "BUSINESS" };
  }

  const expectedHash = otp.code_hash as string;
  const providedHash = await hashOtpCode(params.userId, code);

  if (expectedHash !== providedHash) {
    const attempts = (otp.attempts as number) + 1;
    const maxAttempts = otp.max_attempts as number;
    const shouldConsume = attempts >= maxAttempts;

    const { error: attemptError } = await clientAdmin
      .from("user_phone_otps")
      .update({
        attempts,
        consumed_at: shouldConsume ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", otp.id as number);

    if (attemptError) {
      throw { code: 500, message: "No se pudo actualizar OTP", category: "SYSTEM", details: attemptError };
    }

    throw { code: 422, message: "Codigo de acceso incorrecto", category: "VALIDATION" };
  }

  const nowIso = new Date().toISOString();

  const { error: consumeError } = await clientAdmin
    .from("user_phone_otps")
    .update({ consumed_at: nowIso, updated_at: nowIso })
    .eq("id", otp.id as number)
    .is("consumed_at", null);

  if (consumeError) {
    throw { code: 500, message: "No se pudo consumir OTP", category: "SYSTEM", details: consumeError };
  }

  const sessionMinutes = parseEnvInt("SHIFT_OTP_SESSION_MINUTES", 720);
  const sessionToken = randomTokenHex(32);
  const sessionTokenHash = await sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + sessionMinutes * 60 * 1000).toISOString();

  const { error: revokeError } = await clientAdmin
    .from("user_phone_verification_sessions")
    .update({ revoked_at: nowIso, updated_at: nowIso })
    .eq("user_id", params.userId)
    .eq("purpose", OTP_PURPOSE)
    .eq("trusted_device_id", params.trustedDeviceId)
    .is("revoked_at", null);

  if (revokeError) {
    throw { code: 500, message: "No se pudo reciclar sesion OTP", category: "SYSTEM", details: revokeError };
  }

  const { error: sessionError } = await clientAdmin.from("user_phone_verification_sessions").insert({
    user_id: params.userId,
    purpose: OTP_PURPOSE,
    trusted_device_id: params.trustedDeviceId,
    token_hash: sessionTokenHash,
    verified_at: nowIso,
    expires_at: expiresAt,
    created_at: nowIso,
    updated_at: nowIso,
  });

  if (sessionError) {
    throw { code: 500, message: "No se pudo crear sesion OTP", category: "SYSTEM", details: sessionError };
  }

  return {
    verification_token: sessionToken,
    expires_at: expiresAt,
  };
}

export async function requireShiftOtpSession(params: {
  req: Request;
  userId: string;
  trustedDeviceId: number;
}): Promise<void> {
  const token = params.req.headers.get("x-shift-otp-token")?.trim();
  if (!token || token.length < 16 || token.length > 512) {
    throw {
      code: 403,
      message: "Codigo de acceso requerido para iniciar servicio",
      category: "PERMISSION",
    };
  }

  const tokenHash = await sha256Hex(token);

  const { data: session, error } = await clientAdmin
    .from("user_phone_verification_sessions")
    .select("id, expires_at")
    .eq("user_id", params.userId)
    .eq("purpose", OTP_PURPOSE)
    .eq("trusted_device_id", params.trustedDeviceId)
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    throw { code: 500, message: "No se pudo validar sesion OTP", category: "SYSTEM", details: error };
  }

  if (!session) {
    throw { code: 403, message: "Codigo de acceso invalido", category: "PERMISSION" };
  }

  const expiresAt = new Date(session.expires_at as string).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await clientAdmin
      .from("user_phone_verification_sessions")
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", session.id as number);

    throw { code: 403, message: "Codigo de acceso expirado", category: "PERMISSION" };
  }
}
