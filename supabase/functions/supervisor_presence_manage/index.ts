// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";
import { getSystemSettings } from "../_shared/systemSettings.ts";
import { geoValidatorByRestaurant } from "../_shared/geoValidator.ts";

const endpoint = "supervisor_presence_manage";
const evidenceBucket = "shift-evidence";
const evidenceMaxBytes = 8 * 1024 * 1024;
const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);

async function ensureBucketExists(name: string) {
  const { data, error } = await clientAdmin.storage.getBucket(name);
  if (data?.id) return;
  if (error) {
    const message = (error as { message?: string })?.message?.toLowerCase() ?? "";
    if (!message.includes("not found")) {
      throw error;
    }
  }
  const { error: createError } = await clientAdmin.storage.createBucket(name, { public: false });
  if (createError) {
    const message = (createError as { message?: string })?.message?.toLowerCase() ?? "";
    if (!message.includes("exists")) {
      throw createError;
    }
  }
}

const evidenceItemSchema = z
  .object({
    path: z.string().min(5).max(500),
    label: z.string().trim().min(1).max(200).optional(),
    hash: z.string().min(16).max(200).optional(),
    mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
    size_bytes: z.number().int().positive().max(50_000_000).optional(),
  })
  .strict();

const registerAction = z.object({
  action: z.literal("register"),
  restaurant_id: z.number().int().positive(),
  phase: z.enum(["start", "end"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(10000).optional(),
  evidence_path: z.string().min(5).max(500).optional(),
  evidence_hash: z.string().min(16).max(200).optional(),
  evidence_mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  evidence_size_bytes: z.number().int().positive().max(50000000).optional(),
  evidences: z.array(evidenceItemSchema).min(1).max(20).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const requestEvidenceUploadAction = z.object({
  action: z.literal("request_evidence_upload"),
  phase: z.enum(["start", "end"]),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
});

const finalizeEvidenceUploadAction = z.object({
  action: z.literal("finalize_evidence_upload"),
  path: z.string().min(5).max(500),
});

const listMyAction = z.object({
  action: z.literal("list_my"),
  limit: z.number().int().min(1).max(200).default(20),
});

const listByRestaurantAction = z.object({
  action: z.literal("list_by_restaurant"),
  restaurant_id: z.number().int().positive(),
  limit: z.number().int().min(1).max(500).default(50),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const listTodayAction = z.object({
  action: z.literal("list_today"),
  limit: z.number().int().min(1).max(500).default(20),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

const payloadSchema = z.discriminatedUnion("action", [
  registerAction,
  listMyAction,
  listByRestaurantAction,
  listTodayAction,
  requestEvidenceUploadAction,
  finalizeEvidenceUploadAction,
]);

function mimeToExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

async function sha256Hex(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function detectMimeByMagic(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());

  const isJpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (isJpeg) return "image/jpeg";

  const isPng =
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a;
  if (isPng) return "image/png";

  const isWebp =
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50;
  if (isWebp) return "image/webp";

  return "application/octet-stream";
}

function getBogotaDayRange() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = Number(parts.find((p) => p.type === "year")?.value ?? now.getUTCFullYear());
  const month = Number(parts.find((p) => p.type === "month")?.value ?? now.getUTCMonth() + 1);
  const day = Number(parts.find((p) => p.type === "day")?.value ?? now.getUTCDate());

  // Bogota is UTC-5, so local midnight is 05:00 UTC.
  const startUtc = new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0));
  const endUtc = new Date(Date.UTC(year, month - 1, day + 1, 5, 0, 0, 0));

  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}

serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const request_id = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  let status = 200;
  let error_code: string | undefined;
  let userId: string | undefined;
  let userRole: "super_admin" | "supervisora" | "empleado" | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["super_admin", "supervisora"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 40, window_seconds: 60 });
    const settings = await getSystemSettings(clientAdmin);

    const fetchEvidences = async (supabase: typeof clientAdmin, presenceIds: Array<number | string>) => {
      if (!presenceIds.length) return new Map<string, Array<Record<string, unknown>>>();
      const { data: evidenceRows, error: evidenceError } = await supabase
        .from("supervisor_presence_evidences")
        .select("id, presence_id, storage_path, sha256, mime_type, size_bytes, label, created_at")
        .in("presence_id", presenceIds);

      if (evidenceError) {
        throw { code: 409, message: "No se pudieron cargar evidencias de supervision", category: "BUSINESS", details: evidenceError };
      }

      const map = new Map<string, Array<Record<string, unknown>>>();
      for (const row of evidenceRows ?? []) {
        const key = String(row.presence_id);
        const list = map.get(key) ?? [];
        list.push({
          id: row.id,
          path: row.storage_path,
          sha256: row.sha256,
          mime_type: row.mime_type,
          size_bytes: row.size_bytes,
          label: row.label ?? null,
          created_at: row.created_at,
        });
        map.set(key, list);
      }

      return map;
    };

    const assertSupervisorPath = (path: string, phase?: "start" | "end") => {
      const lower = path.toLowerCase();
      const expectedStart = `users/${user.id}/supervisor-start/`;
      const expectedEnd = `users/${user.id}/supervisor-end/`;
      const legacyA = `users/${user.id}/supervisor/`;
      const legacyB = `users/${user.id}/supervision/`;
      const matchesPhase =
        phase === "start"
          ? lower.startsWith(expectedStart)
          : phase === "end"
            ? lower.startsWith(expectedEnd)
            : lower.startsWith(expectedStart) || lower.startsWith(expectedEnd);

      if (!matchesPhase && !lower.startsWith(legacyA) && !lower.startsWith(legacyB)) {
        throw { code: 403, message: "Ruta de evidencia invalida para supervision", category: "PERMISSION" };
      }
    };

    if (payload.action === "request_evidence_upload") {
      try {
        await ensureBucketExists(evidenceBucket);
      } catch (bucketError) {
        throw { code: 500, message: "No se pudo preparar bucket de evidencia", category: "SYSTEM", details: bucketError };
      }

      const extension = mimeToExtension(payload.mime_type);
      const path = `users/${user.id}/supervisor-${payload.phase}/${request_id}.${extension}`;
      const { data, error } = await clientAdmin.storage.from(evidenceBucket).createSignedUploadUrl(path);
      if (error || !data) {
        throw { code: 500, message: "No se pudo generar URL de carga", category: "SYSTEM", details: error };
      }

      const successPayload = {
        success: true,
        data: {
          upload: data,
          bucket: evidenceBucket,
          path,
          allowed_mime: [...allowedMime],
          max_bytes: evidenceMaxBytes,
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "finalize_evidence_upload") {
      assertSupervisorPath(payload.path);
      const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(evidenceBucket).download(payload.path);
      if (downloadError || !fileBlob) {
        throw { code: 422, message: "Archivo no disponible en storage", category: "VALIDATION", details: downloadError };
      }

      if (fileBlob.size <= 0 || fileBlob.size > evidenceMaxBytes) {
        throw { code: 422, message: "Tamano de archivo invalido", category: "VALIDATION", details: { size: fileBlob.size } };
      }

      const sniffedMime = await detectMimeByMagic(fileBlob);
      if (!allowedMime.has(sniffedMime)) {
        throw { code: 422, message: "MIME no permitido", category: "VALIDATION", details: { sniffedMime } };
      }

      const sha256 = await sha256Hex(fileBlob);

      const successPayload = {
        success: true,
        data: {
          path: payload.path,
          sha256,
          mime_type: sniffedMime,
          size_bytes: fileBlob.size,
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_my") {
      const listClient = user.role === "supervisora" ? clientAdmin : clientUser;
      const { data, error } = await listClient
        .from("supervisor_presence_logs")
        .select(
          "id, supervisor_id, restaurant_id, phase, lat, lng, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, recorded_at, notes"
        )
        .eq("supervisor_id", user.id)
        .order("recorded_at", { ascending: false })
        .limit(payload.limit);

      if (error) {
        throw { code: 409, message: "No se pudo listar presencia", category: "BUSINESS", details: error };
      }

      const items = data ?? [];
      const evidenceMap = await fetchEvidences(listClient, items.map((row) => row.id));
      const withEvidence = items.map((row) => ({
        ...row,
        evidences: evidenceMap.get(String(row.id)) ?? [],
      }));
      const successPayload = { success: true, data: { items: withEvidence }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_by_restaurant") {
      roleGuard(user, ["supervisora", "super_admin"]);

      if ((payload.from && !payload.to) || (!payload.from && payload.to)) {
        throw { code: 422, message: "from y to son requeridos juntos", category: "VALIDATION" };
      }

      if (payload.from && payload.to) {
        const fromDate = new Date(payload.from);
        const toDate = new Date(payload.to);
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
          throw { code: 422, message: "from/to invalidos", category: "VALIDATION" };
        }
        if (fromDate >= toDate) {
          throw { code: 422, message: "from debe ser menor que to", category: "VALIDATION" };
        }
      }

      const listClient = user.role === "supervisora" ? clientAdmin : clientUser;
      let query = listClient
        .from("supervisor_presence_logs")
        .select(
          "id, supervisor_id, restaurant_id, phase, lat, lng, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, recorded_at, notes"
        )
        .eq("restaurant_id", payload.restaurant_id)
        .order("recorded_at", { ascending: false })
        .limit(payload.limit);

      if (payload.from && payload.to) {
        query = query.gte("recorded_at", new Date(payload.from).toISOString()).lt("recorded_at", new Date(payload.to).toISOString());
      }

      const { data, error } = await query;

      if (error) {
        throw { code: 409, message: "No se pudo listar presencia por restaurante", category: "BUSINESS", details: error };
      }

      const items = data ?? [];
      const evidenceMap = await fetchEvidences(listClient, items.map((row) => row.id));
      const withEvidence = items.map((row) => ({
        ...row,
        evidences: evidenceMap.get(String(row.id)) ?? [],
      }));
      const successPayload = { success: true, data: { items: withEvidence }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_today") {
      roleGuard(user, ["super_admin"]);
      let startIso: string;
      let endIso: string;

      if (payload.from || payload.to) {
        if (!payload.from || !payload.to) {
          throw { code: 422, message: "from y to son requeridos juntos", category: "VALIDATION" };
        }
        const fromDate = new Date(payload.from);
        const toDate = new Date(payload.to);
        if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
          throw { code: 422, message: "from/to invalidos", category: "VALIDATION" };
        }
        if (fromDate >= toDate) {
          throw { code: 422, message: "from debe ser menor que to", category: "VALIDATION" };
        }
        startIso = fromDate.toISOString();
        endIso = toDate.toISOString();
      } else {
        const range = getBogotaDayRange();
        startIso = range.startIso;
        endIso = range.endIso;
      }

      const { data, error } = await clientAdmin
        .from("supervisor_presence_logs")
        .select("id, supervisor_id, restaurant_id, phase, recorded_at, notes, users:supervisor_id(full_name), restaurants:restaurant_id(name)")
        .gte("recorded_at", startIso)
        .lt("recorded_at", endIso)
        .order("recorded_at", { ascending: false })
        .limit(payload.limit);

      if (error) {
        throw { code: 409, message: "No se pudo listar supervisiones de hoy", category: "BUSINESS", details: error };
      }

      const baseItems = (data ?? []).map((row) => {
        const supervisorName = row?.users?.full_name ?? row?.users?.[0]?.full_name ?? null;
        const restaurantName = row?.restaurants?.name ?? row?.restaurants?.[0]?.name ?? null;
        return {
          id: row.id,
          supervisor_id: row.supervisor_id,
          supervisor_name: supervisorName,
          restaurant_id: row.restaurant_id,
          restaurant_name: restaurantName,
          phase: row.phase,
          recorded_at: row.recorded_at,
          notes: row.notes ?? null,
        };
      });

      const evidenceMap = await fetchEvidences(clientAdmin, baseItems.map((row) => row.id));
      const items = baseItems.map((row) => ({
        ...row,
        evidences: evidenceMap.get(String(row.id)) ?? [],
      }));

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "register") {
      if (settings.gps.require_gps_for_supervision) {
        await geoValidatorByRestaurant(clientUser, payload.restaurant_id, payload.lat, payload.lng, {
          settings,
          accuracy: payload.accuracy,
        });
      }

      const incomingEvidences = payload.evidences ?? [];
      const legacyEvidence =
        payload.evidence_path && payload.evidence_hash && payload.evidence_mime_type && payload.evidence_size_bytes
          ? [
              {
                path: payload.evidence_path,
                label: undefined,
                hash: payload.evidence_hash,
                mime_type: payload.evidence_mime_type,
                size_bytes: payload.evidence_size_bytes,
              },
            ]
          : [];

      const evidences = [...incomingEvidences, ...legacyEvidence];

      if (settings.evidence.require_supervision_photos && evidences.length === 0) {
        throw { code: 422, message: "Debe adjuntar evidencia de supervision", category: "VALIDATION" };
      }

      const normalizedEvidences: Array<{
        storage_path: string;
        sha256: string;
        mime_type: string;
        size_bytes: number;
        label: string | null;
      }> = [];

      for (const evidence of evidences) {
        assertSupervisorPath(evidence.path, payload.phase);
        const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(evidenceBucket).download(evidence.path);
        if (downloadError || !fileBlob) {
          throw { code: 422, message: "Evidencia no disponible en storage", category: "VALIDATION", details: downloadError };
        }

        if (fileBlob.size <= 0 || fileBlob.size > evidenceMaxBytes) {
          throw { code: 422, message: "Tamano de evidencia invalido", category: "VALIDATION", details: { size: fileBlob.size } };
        }

        const sniffedMime = await detectMimeByMagic(fileBlob);
        if (!allowedMime.has(sniffedMime)) {
          throw { code: 422, message: "MIME no permitido", category: "VALIDATION", details: { sniffedMime } };
        }

        const sha256 = await sha256Hex(fileBlob);
        normalizedEvidences.push({
          storage_path: evidence.path,
          sha256,
          mime_type: sniffedMime,
          size_bytes: fileBlob.size,
          label: evidence.label ?? null,
        });
      }

      const primaryEvidence = normalizedEvidences[0] ?? null;

      const insertClient = user.role === "supervisora" ? clientAdmin : clientUser;
      const { data, error } = await insertClient
        .from("supervisor_presence_logs")
        .insert({
          supervisor_id: user.id,
          restaurant_id: payload.restaurant_id,
          phase: payload.phase,
          lat: payload.lat,
          lng: payload.lng,
          evidence_path: primaryEvidence?.storage_path ?? null,
          evidence_hash: primaryEvidence?.sha256 ?? null,
          evidence_mime_type: primaryEvidence?.mime_type ?? null,
          evidence_size_bytes: primaryEvidence?.size_bytes ?? null,
          notes: payload.notes ?? null,
          recorded_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (error || !data?.id) {
        throw { code: 409, message: "No se pudo registrar presencia", category: "BUSINESS", details: error };
      }

      if (normalizedEvidences.length > 0) {
        const evidenceRows = normalizedEvidences.map((row) => ({
          presence_id: data.id,
          storage_path: row.storage_path,
          sha256: row.sha256,
          mime_type: row.mime_type,
          size_bytes: row.size_bytes,
          label: row.label,
          created_at: new Date().toISOString(),
        }));

        const { error: evidenceInsertError } = await insertClient.from("supervisor_presence_evidences").insert(evidenceRows);
        if (evidenceInsertError) {
          throw { code: 409, message: "No se pudo guardar evidencias de supervision", category: "BUSINESS", details: evidenceInsertError };
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SUPERVISOR_PRESENCE_REGISTER",
        context: {
          presence_id: data.id,
          restaurant_id: payload.restaurant_id,
          phase: payload.phase,
          evidence_count: normalizedEvidences.length,
        },
        request_id,
      });

      const successPayload = { success: true, data: { presence_id: data.id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    throw { code: 422, message: "Accion no soportada", category: "VALIDATION" };
  } catch (err) {
    const apiError = errorHandler(err, request_id);
    status = apiError.code;
    error_code = apiError.category;

    if (userId && idempotencyKey) {
      const failPayload = { success: false, data: null, error: apiError, request_id };
      await safeFinalizeIdempotency({ userId, endpoint, key: idempotencyKey, statusCode: apiError.code, responseBody: failPayload });
    }

    return response(false, null, apiError, request_id);
  } finally {
    logRequest({
      request_id,
      endpoint,
      method: req.method,
      ip,
      user_agent: userAgent,
      user: userId && userRole ? { id: userId, role: userRole } : undefined,
      duration_ms: Date.now() - startedAt,
      status,
      error_code,
    });
  }
});
