import { clientAdmin } from "./supabaseClient.ts";
import { response } from "./response.ts";

type StoredRecord = {
  status_code: number;
  response_body: unknown;
};

type ClaimOutcome =
  | { type: "claimed" }
  | { type: "replay"; stored: StoredRecord };

function pickRow<T>(data: T | T[] | null): T | null {
  if (!data) return null;
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

export async function claimIdempotency(params: {
  userId: string;
  endpoint: string;
  key: string;
  payloadHash: string;
}): Promise<ClaimOutcome> {
  const { data, error } = await clientAdmin.rpc("idempotency_claim", {
    p_user_id: params.userId,
    p_endpoint: params.endpoint,
    p_key: params.key,
    p_payload_hash: params.payloadHash,
  });

  if (error) {
    throw { code: 500, message: "No se pudo reclamar idempotencia", category: "SYSTEM", details: error };
  }

  const row = pickRow(data as Record<string, unknown> | Record<string, unknown>[] | null);
  if (!row) {
    throw { code: 500, message: "Respuesta idempotencia vacia", category: "SYSTEM" };
  }

  const outcome = String(row.outcome ?? "");

  if (outcome === "claimed") {
    return { type: "claimed" };
  }

  if (outcome === "replay") {
    return {
      type: "replay",
      stored: {
        status_code: Number(row.status_code ?? 200),
        response_body: row.response_body,
      },
    };
  }

  if (outcome === "processing") {
    throw { code: 409, message: "Request idempotente en procesamiento", category: "BUSINESS" };
  }

  if (outcome === "payload_conflict") {
    throw { code: 409, message: "Idempotency-Key reutilizada con payload distinto", category: "VALIDATION" };
  }

  throw { code: 500, message: "Estado de idempotencia desconocido", category: "SYSTEM", details: row };
}

export function replayIdempotentResponse(stored: StoredRecord, requestId: string): Response {
  const payload = (stored.response_body ?? {}) as Record<string, unknown>;
  return response(Boolean(payload.success), payload.data ?? null, (payload.error as { code?: number } | null) ?? null, requestId);
}

export async function finalizeIdempotency(params: {
  userId: string;
  endpoint: string;
  key: string;
  statusCode: number;
  responseBody: unknown;
}) {
  const { error } = await clientAdmin.rpc("idempotency_finalize", {
    p_user_id: params.userId,
    p_endpoint: params.endpoint,
    p_key: params.key,
    p_status_code: params.statusCode,
    p_response_body: params.responseBody,
  });

  if (error) {
    throw { code: 500, message: "No se pudo finalizar idempotencia", category: "SYSTEM", details: error };
  }
}

export async function safeFinalizeIdempotency(params: {
  userId: string;
  endpoint: string;
  key: string;
  statusCode: number;
  responseBody: unknown;
}) {
  try {
    await finalizeIdempotency(params);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "IDEMPOTENCY_FINALIZE_ERROR",
        endpoint: params.endpoint,
        user_id: params.userId,
        error,
      })
    );
  }
}
