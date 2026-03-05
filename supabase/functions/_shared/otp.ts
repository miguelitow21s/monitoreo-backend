import { clientAdmin } from "./supabaseClient.ts";
import { randomNumericCode, randomTokenHex, sha256Hex } from "./crypto.ts";

const OTP_PURPOSE = "shift_ops";
const E164_PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;

type OtpDeliveryResult =
  | { status: "sent"; provider_ref: string | null }
  | { status: "debug"; provider_ref: null }
  | { status: "provider_not_configured"; provider_ref: null };

function parseEnvInt(name: string, fallback: number): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function envIsTrue(name: string): boolean {
  return (Deno.env.get(name) ?? "").trim().toLowerCase() === "true";
}

function maskPhone(phone: string): string {
  if (phone.length <= 6) return "***";
  return `${phone.slice(0, 3)}***${phone.slice(-3)}`;
}

function buildOtpMessage(code: string, ttlSeconds: number): string {
  const ttlMinutes = Math.max(1, Math.ceil(ttlSeconds / 60));
  const template = Deno.env.get("OTP_SMS_TEMPLATE")?.trim();
  if (template) {
    return template.replaceAll("{{code}}", code).replaceAll("{{minutes}}", String(ttlMinutes));
  }
  return `Tu codigo OTP es ${code}. Expira en ${ttlMinutes} minutos.`;
}

async function sendSmsViaTwilio(toPhone: string, message: string): Promise<OtpDeliveryResult> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")?.trim();
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")?.trim();
  const messagingServiceSid = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID")?.trim();
  const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER")?.trim();

  if (!accountSid || !authToken || (!messagingServiceSid && !fromNumber)) {
    return { status: "provider_not_configured", provider_ref: null };
  }

  const body = new URLSearchParams({
    To: toPhone,
    Body: message,
  });

  if (messagingServiceSid) {
    body.set("MessagingServiceSid", messagingServiceSid);
  } else if (fromNumber) {
    body.set("From", fromNumber);
  }

  const auth = btoa(`${accountSid}:${authToken}`);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = (await res.json().catch(() => null)) as { sid?: string; message?: string; code?: number } | null;
  if (!res.ok) {
    throw {
      code: 503,
      message: "No se pudo enviar OTP por SMS",
      category: "SYSTEM",
      details: payload ?? { status: res.status },
    };
  }

  return {
    status: "sent",
    provider_ref: payload?.sid ?? null,
  };
}

async function hashOtpCode(userId: string, code: string): Promise<string> {
  const pepper = Deno.env.get("OTP_HASH_PEPPER") ?? "";
  return sha256Hex(`${userId}:${code}:${pepper}`);
}

export async function getUserPhoneForOtp(userId: string): Promise<string> {
  const { data, error } = await clientAdmin.from("users").select("id, phone_e164").eq("id", userId).single();

  if (error || !data) {
    throw { code: 404, message: "Usuario no encontrado", category: "BUSINESS", details: error };
  }

  const phone = (data as { phone_e164?: string | null }).phone_e164?.trim() ?? "";
  if (!phone) {
    throw { code: 409, message: "Usuario sin celular verificado en perfil", category: "BUSINESS" };
  }

  if (!E164_PHONE_REGEX.test(phone)) {
    throw { code: 409, message: "Celular invalido. Usa formato E.164 (+573001112233)", category: "BUSINESS" };
  }

  return phone;
}

export async function issueShiftOtp(params: {
  userId: string;
}): Promise<{
  otp_id: number;
  expires_at: string;
  masked_phone: string;
  delivery_status: "sent" | "debug";
  debug_code?: string;
}> {
  const ttlSeconds = parseEnvInt("OTP_TTL_SECONDS", 300);
  const debugMode = envIsTrue("OTP_DEBUG_MODE");
  const phone = await getUserPhoneForOtp(params.userId);
  const code = randomNumericCode(6);
  const message = buildOtpMessage(code, ttlSeconds);

  let delivery: OtpDeliveryResult;
  try {
    delivery = await sendSmsViaTwilio(phone, message);
  } catch (err) {
    if (!debugMode) {
      throw err;
    }
    delivery = { status: "debug", provider_ref: null };
  }

  if (delivery.status === "provider_not_configured" && !debugMode) {
    throw {
      code: 503,
      message: "Proveedor SMS no configurado",
      category: "SYSTEM",
      details: { required_env: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER|TWILIO_MESSAGING_SERVICE_SID"] },
    };
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
      phone_e164: phone,
      purpose: OTP_PURPOSE,
      code_hash: codeHash,
      expires_at: expiresAt,
      max_attempts: 5,
      attempts: 0,
      delivery_status: delivery.status,
      provider_ref: delivery.provider_ref,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    throw { code: 500, message: "No se pudo crear OTP", category: "SYSTEM", details: error };
  }

  const response: {
    otp_id: number;
    expires_at: string;
    masked_phone: string;
    delivery_status: "sent" | "debug";
    debug_code?: string;
  } = {
    otp_id: data.id as number,
    expires_at: expiresAt,
    masked_phone: maskPhone(phone),
    delivery_status: delivery.status === "sent" ? "sent" : "debug",
  };

  if (debugMode) {
    response.debug_code = code;
  }

  return response;
}

export async function verifyShiftOtpCode(params: {
  userId: string;
  code: string;
  trustedDeviceId: number;
}): Promise<{ verification_token: string; expires_at: string }> {
  const code = params.code.trim();
  if (!/^\d{6}$/.test(code)) {
    throw { code: 422, message: "Codigo OTP invalido", category: "VALIDATION" };
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
    throw { code: 409, message: "No hay OTP activo para validar", category: "BUSINESS" };
  }

  const now = Date.now();
  const otpExpires = new Date(otp.expires_at as string).getTime();
  if (!Number.isFinite(otpExpires) || otpExpires <= now) {
    await clientAdmin.from("user_phone_otps").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id as number);
    throw { code: 409, message: "OTP expirado", category: "BUSINESS" };
  }

  if ((otp.attempts as number) >= (otp.max_attempts as number)) {
    await clientAdmin.from("user_phone_otps").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id as number);
    throw { code: 409, message: "OTP bloqueado por intentos", category: "BUSINESS" };
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

    throw { code: 422, message: "Codigo OTP incorrecto", category: "VALIDATION" };
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
      message: "OTP de celular requerido para operar turnos",
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
    throw { code: 403, message: "OTP de celular invalido", category: "PERMISSION" };
  }

  const expiresAt = new Date(session.expires_at as string).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    await clientAdmin
      .from("user_phone_verification_sessions")
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", session.id as number);

    throw { code: 403, message: "OTP de celular expirado", category: "PERMISSION" };
  }
}
