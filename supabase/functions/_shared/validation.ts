import { z } from "jsr:@zod/zod@3.23.8";

export function requireMethod(req: Request, allowed: string[]) {
  if (!allowed.includes(req.method)) {
    throw { code: 405, message: "Metodo no permitido", category: "VALIDATION", details: { allowed } };
  }
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw { code: 415, message: "Content-Type no soportado", category: "VALIDATION" };
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw { code: 422, message: "Body JSON invalido", category: "VALIDATION" };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw {
      code: 422,
      message: "Payload invalido",
      category: "VALIDATION",
      details: parsed.error.flatten(),
    };
  }

  return parsed.data;
}

export function requireIdempotencyKey(req: Request): string {
  const key = req.headers.get("Idempotency-Key")?.trim();
  if (!key || key.length < 8 || key.length > 128) {
    throw { code: 422, message: "Idempotency-Key invalido", category: "VALIDATION" };
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
