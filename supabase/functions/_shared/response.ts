const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") {
    return null;
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    },
  });
}

export function response(success: boolean, data: unknown, error: { code?: number } | null, request_id: string) {
  return new Response(JSON.stringify({ success, data, error, request_id }), {
    status: error?.code || 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": request_id,
      "Access-Control-Expose-Headers": "X-Request-Id",
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    },
  });
}

