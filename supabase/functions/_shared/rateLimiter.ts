import { clientAdmin } from "./supabaseClient.ts";

export async function rateLimiter(params: {
  user_id: string;
  ip: string;
  endpoint: string;
  limit: number;
  window_seconds: number;
}) {
  const trustedIp = params.ip || "trusted-proxy-unknown";
  const bucket = `${params.user_id}:${trustedIp}:${params.endpoint}`;
  const { data, error } = await clientAdmin.rpc("check_rate_limit", {
    p_bucket: bucket,
    p_limit: params.limit,
    p_window_seconds: params.window_seconds,
  });

  if (error) {
    throw { code: 500, error_code: "RATE_LIMIT_CHECK_FAILED", message: "No se pudo validar el limite de solicitudes", category: "SYSTEM", details: error };
  }

  if (!data) {
    throw {
      code: 429,
      error_code: "RATE_LIMITED",
      message: "Demasiadas solicitudes en poco tiempo. Espera un momento e intenta de nuevo",
      category: "PERMISSION",
      details: { endpoint: params.endpoint, limit: params.limit, window_seconds: params.window_seconds },
    };
  }
}
