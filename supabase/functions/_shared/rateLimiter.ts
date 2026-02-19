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
    throw { code: 500, message: "Fallo rate limit", category: "SYSTEM", details: error };
  }

  if (!data) {
    throw { code: 429, message: "Rate limit excedido", category: "PERMISSION" };
  }
}
