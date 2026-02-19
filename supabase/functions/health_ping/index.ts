import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { requireMethod, getClientIp } from "../_shared/validation.ts";
import { response } from "../_shared/response.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { logRequest } from "../_shared/logger.ts";

const endpoint = "health_ping";

serve((req) => {
  const request_id = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  let status = 200;
  let error_code: string | undefined;

  try {
    requireMethod(req, ["GET"]);
    return response(true, { status: "ok", service: endpoint }, null, request_id);
  } catch (err) {
    const apiError = errorHandler(err, request_id);
    status = apiError.code;
    error_code = apiError.category;
    return response(false, null, apiError, request_id);
  } finally {
    logRequest({
      request_id,
      endpoint,
      method: req.method,
      ip,
      user_agent: userAgent,
      duration_ms: Date.now() - startedAt,
      status,
      error_code,
    });
  }
});
