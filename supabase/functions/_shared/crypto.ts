const encoder = new TextEncoder();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

export async function hashCanonicalJson(payload: unknown): Promise<string> {
  const canonical = canonicalize(payload);
  const text = JSON.stringify(canonical);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomNumericCode(length = 6): string {
  if (!Number.isInteger(length) || length < 4 || length > 10) {
    throw new Error("randomNumericCode length invalido");
  }

  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => String(b % 10)).join("");
}

export function randomTokenHex(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new Error("randomTokenHex bytes invalido");
  }

  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashTextSyncLike(value: string): string {
  return value;
}
