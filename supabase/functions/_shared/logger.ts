import type { InternalUser } from "./types.ts";

export function logRequest(params: {
  request_id: string;
  endpoint: string;
  method: string;
  ip: string;
  user_agent: string;
  user?: InternalUser;
  duration_ms: number;
  status: number;
  error_code?: string;
}) {
  console.log(
    JSON.stringify({
      request_id: params.request_id,
      user_id: params.user?.id ?? null,
      role: params.user?.role ?? null,
      endpoint: params.endpoint,
      method: params.method,
      ip: params.ip,
      user_agent: params.user_agent,
      duration_ms: params.duration_ms,
      status: params.status,
      error_code: params.error_code ?? null,
      timestamp: new Date().toISOString(),
    })
  );
}
