import type { ApiError, AppError } from "./types.ts";

function normalizeError(error: unknown): AppError {
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    const code = typeof e.code === "number" ? e.code : null;
    const message = typeof e.message === "string" ? e.message : null;
    const category = typeof e.category === "string" ? e.category : null;

    if (code && message && category) {
      return {
        code,
        message,
        category: category as AppError["category"],
      };
    }

    if (typeof e.code === "string" && e.code.startsWith("22")) {
      return { code: 422, message: "Datos invalidos", category: "VALIDATION" };
    }
  }

  return {
    code: 500,
    message: "Error interno",
    category: "SYSTEM",
  };
}

export function errorHandler(error: unknown, request_id: string): ApiError {
  const appError = normalizeError(error);

  console.error(
    JSON.stringify({
      request_id,
      category: appError.category,
      code: appError.code,
      raw_error: error,
      ts: new Date().toISOString(),
    })
  );

  return {
    ...appError,
    request_id,
  };
}
