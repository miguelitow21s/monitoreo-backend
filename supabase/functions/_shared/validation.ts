import { z } from "npm:zod@3.23.8";

export function requireMethod(req: Request, allowed: string[]) {
  if (!allowed.includes(req.method)) {
    throw { code: 405, error_code: "METHOD_NOT_ALLOWED", message: "Metodo no permitido", category: "VALIDATION", details: { allowed, received: req.method } };
  }
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw { code: 415, error_code: "UNSUPPORTED_CONTENT_TYPE", message: "Content-Type no soportado (usa application/json)", category: "VALIDATION", details: { received: contentType || null } };
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw { code: 422, error_code: "INVALID_JSON_BODY", message: "El cuerpo de la solicitud no es JSON valido", category: "VALIDATION" };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const issuePath = firstIssue?.path?.length ? firstIssue.path.join(".") : "payload";
    const issueMessage = firstIssue?.message ?? "Payload invalido";
    const friendly = `Payload invalido: ${issuePath} ${issueMessage}`.trim();
    throw {
      code: 422,
      error_code: "PAYLOAD_VALIDATION_FAILED",
      message: friendly,
      category: "VALIDATION",
      details: { field: issuePath, issue: issueMessage, ...parsed.error.flatten() },
    };
  }

  return parsed.data;
}

export function requireIdempotencyKey(req: Request): string {
  const key = req.headers.get("Idempotency-Key")?.trim();
  if (!key || key.length < 8 || key.length > 128) {
    throw { code: 422, error_code: "IDEMPOTENCY_KEY_INVALID", message: "Falta o es invalido el Idempotency-Key de la solicitud", category: "VALIDATION" };
  }
  return key;
}

export function getClientIp(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp && !cfIp.includes(",")) return cfIp;

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && !realIp.includes(",")) return realIp;

  return "trusted-proxy-unknown";
}

export const commonSchemas = {
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  shiftId: z.number().int().positive(),
  restaurantId: z.number().int().positive(),
  supplyId: z.number().int().positive(),
  quantity: z.number().int().positive().max(100000),
  photoType: z.enum(["inicio", "fin"]),
  dateYmd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accuracy: z.number().min(0).max(10000),
  capturedAt: z.string().datetime(),
};
