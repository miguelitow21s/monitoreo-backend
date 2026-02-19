export function response(success: boolean, data: unknown, error: { code?: number } | null, request_id: string) {
  return new Response(JSON.stringify({ success, data, error, request_id }), {
    status: error?.code || 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": request_id,
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    },
  });
}
