import { clientAdmin } from "./supabaseClient.ts";
import { sha256Hex } from "./crypto.ts";

const FINGERPRINT_HEADERS = ["x-device-fingerprint", "x-device-id", "x-device-key"] as const;
const MIN_FINGERPRINT_LENGTH = 16;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_TRUSTED_DEVICES_PER_USER = 1;

export type TrustedDevice = {
  id: number;
  user_id: string;
  device_name: string | null;
  platform: string | null;
  first_login_binding: boolean;
  trusted_at: string;
  last_seen_at: string;
};

function sanitizeLabel(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeIpAddress(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim();
  if (!trimmed || trimmed === "trusted-proxy-unknown" || trimmed.includes(",")) return null;
  if (/^[0-9A-Fa-f:.]+$/.test(trimmed)) return trimmed;
  return null;
}

export function getDeviceFingerprint(req: Request, bodyFingerprint?: string | null): string {
  const byHeader = FINGERPRINT_HEADERS
    .map((header) => req.headers.get(header)?.trim() ?? "")
    .find((value) => value.length > 0);

  const candidate = (bodyFingerprint ?? byHeader ?? "").trim();

  if (!candidate) {
    throw { code: 422, message: "Falta identificador de dispositivo", category: "VALIDATION" };
  }

  if (candidate.length < MIN_FINGERPRINT_LENGTH || candidate.length > MAX_FINGERPRINT_LENGTH) {
    throw { code: 422, message: "Identificador de dispositivo invalido", category: "VALIDATION" };
  }

  return candidate;
}

async function countActiveTrustedDevices(userId: string): Promise<number> {
  const { count, error } = await clientAdmin
    .from("user_trusted_devices")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("revoked_at", null);

  if (error) {
    throw { code: 500, message: "No se pudo consultar dispositivos confiables", category: "SYSTEM", details: error };
  }

  return count ?? 0;
}

async function loadActiveTrustedDevice(userId: string, fingerprintHash: string): Promise<TrustedDevice | null> {
  const { data, error } = await clientAdmin
    .from("user_trusted_devices")
    .select("id, user_id, device_name, platform, first_login_binding, trusted_at, last_seen_at")
    .eq("user_id", userId)
    .eq("device_fingerprint_hash", fingerprintHash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    throw { code: 500, message: "No se pudo consultar dispositivo", category: "SYSTEM", details: error };
  }

  return (data as TrustedDevice | null) ?? null;
}

async function updateDeviceSeen(deviceId: number, ip: string | null, userAgent: string | null) {
  const { error } = await clientAdmin
    .from("user_trusted_devices")
    .update({
      last_seen_at: new Date().toISOString(),
      ip_address: normalizeIpAddress(ip),
      user_agent: sanitizeLabel(userAgent, 500),
    })
    .eq("id", deviceId);

  if (error) {
    throw { code: 500, message: "No se pudo actualizar dispositivo", category: "SYSTEM", details: error };
  }
}

export async function getTrustedDeviceStatus(params: {
  userId: string;
  req: Request;
  bodyFingerprint?: string | null;
}): Promise<{
  trusted: boolean;
  first_login_binding: boolean;
  trusted_devices_count: number;
  device: TrustedDevice | null;
}> {
  const fingerprint = getDeviceFingerprint(params.req, params.bodyFingerprint);
  const fingerprintHash = await sha256Hex(fingerprint);
  const [activeCount, device] = await Promise.all([
    countActiveTrustedDevices(params.userId),
    loadActiveTrustedDevice(params.userId, fingerprintHash),
  ]);

  if (device) {
    await updateDeviceSeen(
      device.id,
      params.req.headers.get("cf-connecting-ip") ?? params.req.headers.get("x-real-ip"),
      params.req.headers.get("user-agent")
    );
  }

  return {
    trusted: Boolean(device),
    first_login_binding: activeCount === 0,
    trusted_devices_count: activeCount,
    device,
  };
}

export async function requireTrustedDevice(params: {
  userId: string;
  req: Request;
  bodyFingerprint?: string | null;
}): Promise<TrustedDevice> {
  const status = await getTrustedDeviceStatus(params);

  if (status.device) {
    return status.device;
  }

  if (status.first_login_binding) {
    throw {
      code: 428,
      message: "Debes registrar tu dispositivo en el primer login",
      category: "PERMISSION",
    };
  }

  throw {
    code: 403,
    message: "Dispositivo no confiable para esta cuenta",
    category: "PERMISSION",
  };
}

export async function registerTrustedDevice(params: {
  userId: string;
  req: Request;
  bodyFingerprint?: string | null;
  deviceName?: string | null;
  platform?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<TrustedDevice> {
  const fingerprint = getDeviceFingerprint(params.req, params.bodyFingerprint);
  const fingerprintHash = await sha256Hex(fingerprint);

  const { data: existing, error: existingError } = await clientAdmin
    .from("user_trusted_devices")
    .select("id, revoked_at")
    .eq("user_id", params.userId)
    .eq("device_fingerprint_hash", fingerprintHash)
    .maybeSingle();

  if (existingError) {
    throw { code: 500, message: "No se pudo consultar dispositivo", category: "SYSTEM", details: existingError };
  }

  const activeCount = await countActiveTrustedDevices(params.userId);

  const isExistingActive = Boolean(existing?.id && !existing.revoked_at);
  const hasAnotherActiveDevice = activeCount > 0 && !isExistingActive;

  if (hasAnotherActiveDevice) {
    throw {
      code: 409,
      message: "Esta cuenta ya esta vinculada a otro dispositivo. Revoca el dispositivo actual para registrar uno nuevo",
      category: "BUSINESS",
    };
  }

  if (!existing && activeCount >= MAX_TRUSTED_DEVICES_PER_USER) {
    throw {
      code: 409,
      message: "Esta cuenta ya esta vinculada a otro dispositivo. Revoca el dispositivo actual para registrar uno nuevo",
      category: "BUSINESS",
    };
  }

  const nowIso = new Date().toISOString();
  const payload = {
    user_id: params.userId,
    device_fingerprint_hash: fingerprintHash,
    device_name: sanitizeLabel(params.deviceName, 120),
    platform: sanitizeLabel(params.platform, 60),
    user_agent: sanitizeLabel(params.userAgent ?? params.req.headers.get("user-agent"), 500),
    ip_address: normalizeIpAddress(params.ip),
    first_login_binding: activeCount === 0,
    trusted_at: nowIso,
    last_seen_at: nowIso,
    revoked_at: null,
    revoked_by: null,
    updated_at: nowIso,
  };

  if (existing?.id) {
    const { error: updateError } = await clientAdmin
      .from("user_trusted_devices")
      .update(payload)
      .eq("id", existing.id);

    if (updateError) {
      throw { code: 500, message: "No se pudo actualizar dispositivo", category: "SYSTEM", details: updateError };
    }
  } else {
    const { error: insertError } = await clientAdmin.from("user_trusted_devices").insert(payload);
    if (insertError) {
      throw { code: 500, message: "No se pudo registrar dispositivo", category: "SYSTEM", details: insertError };
    }
  }

  const trusted = await loadActiveTrustedDevice(params.userId, fingerprintHash);
  if (!trusted) {
    throw { code: 500, message: "No se pudo confirmar dispositivo confiable", category: "SYSTEM" };
  }

  return trusted;
}

export async function revokeTrustedDevice(params: {
  userId: string;
  deviceId?: number;
  fingerprint?: string | null;
  revokedBy?: string;
}): Promise<{ revoked_device_id: number }> {
  if (!params.deviceId && !params.fingerprint) {
    throw { code: 422, message: "Debe indicar device_id o device_fingerprint", category: "VALIDATION" };
  }

  let query = clientAdmin
    .from("user_trusted_devices")
    .select("id")
    .eq("user_id", params.userId)
    .is("revoked_at", null);

  if (params.deviceId) {
    query = query.eq("id", params.deviceId);
  } else if (params.fingerprint) {
    const fingerprintHash = await sha256Hex(params.fingerprint.trim());
    query = query.eq("device_fingerprint_hash", fingerprintHash);
  }

  const { data: target, error: targetError } = await query.maybeSingle();

  if (targetError) {
    throw { code: 500, message: "No se pudo consultar dispositivo", category: "SYSTEM", details: targetError };
  }

  if (!target?.id) {
    throw { code: 404, message: "Dispositivo confiable no encontrado", category: "BUSINESS" };
  }

  const { error: updateError } = await clientAdmin
    .from("user_trusted_devices")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: params.revokedBy ?? params.userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", target.id)
    .eq("user_id", params.userId)
    .is("revoked_at", null);

  if (updateError) {
    throw { code: 500, message: "No se pudo revocar dispositivo", category: "SYSTEM", details: updateError };
  }

  return { revoked_device_id: target.id as number };
}
