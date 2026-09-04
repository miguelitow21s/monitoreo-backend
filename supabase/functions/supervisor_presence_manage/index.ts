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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // 8 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;  // 50 MB (short inspector clip of a reported issue)
// Signed-URL lifetime for reads, matched to the rest of the API (2h). The admin
// opens these on demand when expanding an audit card.
const evidenceUrlTtlSeconds = 7200;
const allowedImageMimeValues = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
// iOS native camera returns .mov (video/quicktime) or .mp4. The DB stores the
// SNIFFED mime, so these three are what land in storage and the CHECK constraint
// (migration 065). A client may also LABEL a .mov as the non-standard "video/mov"
// -- accepted at the schema, but the magic-byte sniff resolves it to quicktime.
const allowedVideoMimeValues = ["video/mp4", "video/quicktime", "video/webm"] as const;
const acceptedDeclaredMimeValues = [...allowedImageMimeValues, ...allowedVideoMimeValues, "video/mov"] as const;
// Set used by the magic-byte sniff to accept a file: the real detected mimes.
const allowedMime = new Set<string>([...allowedImageMimeValues, ...allowedVideoMimeValues]);
const mediaMimeSchema = z.enum(acceptedDeclaredMimeValues);
function isVideoMime(mime: string): boolean {
  return (allowedVideoMimeValues as readonly string[]).includes(mime) || mime === "video/mov";
}
function maxBytesForMime(mime: string): number {
  return isVideoMime(mime) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

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
    mime_type: mediaMimeSchema.optional(),
    size_bytes: z.coerce.number().int().positive().max(50_000_000).optional(),
  })
  .strict();

const registerAction = z.object({
  action: z.literal("register"),
  restaurant_id: z.coerce.number().int().positive(),
  phase: z.enum(["start", "end"]),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(10000).optional(),
  evidence_path: z.string().min(5).max(500).optional(),
  evidence_hash: z.string().min(16).max(200).optional(),
  evidence_mime_type: mediaMimeSchema.optional(),
  evidence_size_bytes: z.coerce.number().int().positive().max(50000000).optional(),
  // A full audit stamps one photo per subarea (Cocina/Comedor/Banos/Fachadas...)
  // plus free observation attachments, so 20 was too tight. 50 covers today's
  // worst case (~25-30) with headroom; the download+hash below runs with bounded
  // concurrency so the wall-clock stays low. (Images only, 8 MB each.)
  evidences: z.array(evidenceItemSchema).min(1).max(50).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const requestEvidenceUploadAction = z.object({
  action: z.literal("request_evidence_upload"),
  phase: z.enum(["start", "end"]),
  mime_type: mediaMimeSchema.default("image/jpeg"),
});

const finalizeEvidenceUploadAction = z.object({
  action: z.literal("finalize_evidence_upload"),
  path: z.string().min(5).max(500),
});

// --- Progressive upload (draft audit) ---
// start -> create the audit as a DRAFT on arrival; returns supervision_id.
const startAction = z.object({
  action: z.literal("start"),
  restaurant_id: z.coerce.number().int().positive(),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(10000).optional(),
});
// get_active_draft -> resume: return the inspector's open draft for a restaurant.
const getActiveDraftAction = z.object({
  action: z.literal("get_active_draft"),
  restaurant_id: z.coerce.number().int().positive(),
});
// attach_evidence -> hang one already-uploaded file on the draft (validated+hashed
// here, distributing the cost across the walk). mime_type/size_bytes are hints; the
// backend re-sniffs and re-hashes authoritatively.
const attachEvidenceAction = z.object({
  action: z.literal("attach_evidence"),
  presence_id: z.coerce.number().int().positive(),
  path: z.string().min(5).max(500),
  label: z.string().trim().min(1).max(200).optional(),
  mime_type: mediaMimeSchema.optional(),
  size_bytes: z.coerce.number().int().positive().max(50_000_000).optional(),
  meta: z.record(z.any()).optional(),
});
// finalize -> draft becomes completed; only metadata (notes), no photos.
const finalizeAction = z.object({
  action: z.literal("finalize"),
  presence_id: z.coerce.number().int().positive(),
  notes: z.string().trim().max(1000).optional().nullable(),
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
  startAction,
  getActiveDraftAction,
  attachEvidenceAction,
  finalizeAction,
]);

// Same cap as the atomic register path.
const MAX_SUPERVISION_EVIDENCES = 50;

function mimeToExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "image/heif") return "heif";
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/quicktime" || mimeType === "video/mov") return "mov";
  if (mimeType === "video/webm") return "webm";
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

  // WebM / Matroska: EBML header 1A 45 DF A3.
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "video/webm";
  }

  const brand = String.fromCharCode(...head.slice(8, 12)).toLowerCase();
  if (head.length >= 12 && String.fromCharCode(...head.slice(4, 8)) === "ftyp") {
    // ISO-BMFF container: brand tells still-image (HEIC/HEIF) from video (MOV/MP4).
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
    if (brand.startsWith("qt")) return "video/quicktime"; // iOS .mov brand "qt  "
    // Everything else with an ftyp box is a QuickTime/MP4-family video.
    return "video/mp4";
  }

  return "application/octet-stream";
}

async function ensureActiveRestaurant(restaurantId: number) {
  const { data, error } = await clientAdmin
    .from("restaurants")
    .select("id, is_active, lat, lng, radius, geofence_radius_m")
    .eq("id", restaurantId)
    .single();

  if (error || !data) {
    throw { code: 404, message: "Restaurante no encontrado", category: "BUSINESS", details: error };
  }

  if (data.is_active === false) {
    throw { code: 422, message: "Restaurante inactivo", category: "VALIDATION" };
  }

  const radius = Number.isFinite(Number(data.geofence_radius_m))
    ? Number(data.geofence_radius_m)
    : Number(data.radius);

  if (
    !Number.isFinite(Number(data.lat)) ||
    !Number.isFinite(Number(data.lng)) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    throw { code: 422, message: "Restaurante sin geocerca configurada", category: "VALIDATION" };
  }
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

function getUtcDayRange(baseDate: Date = new Date()) {
  const startUtc = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), 0, 0, 0, 0));
  const endUtc = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + 1, 0, 0, 0, 0));
  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}

async function findOpenStartPresenceForUtcDay(
  supabase: any,
  supervisorId: string,
  restaurantId: number,
) {
  const { startIso, endIso } = getUtcDayRange();

  const { data: rows, error } = await supabase
    .from("supervisor_presence_logs")
    .select("id, phase, recorded_at")
    .eq("supervisor_id", supervisorId)
    .eq("restaurant_id", restaurantId)
    .gte("recorded_at", startIso)
    .lt("recorded_at", endIso)
    .order("recorded_at", { ascending: true });

  if (error || !rows || rows.length === 0) {
    return null;
  }

  const starts = rows.filter((row: { phase?: string }) => row.phase === "start");
  const ends = rows.filter((row: { phase?: string }) => row.phase === "end");

  let openStart: { id: number; recorded_at: string } | null = null;
  for (const start of starts) {
    const hasEndAfter = ends.some(
      (end) => new Date(end.recorded_at).getTime() >= new Date(start.recorded_at).getTime(),
    );
    if (!hasEndAfter) {
      openStart = { id: start.id, recorded_at: start.recorded_at };
    }
  }

  return openStart;
}

function mapPresenceInsertError(raw: unknown) {
  const normalized = String(
    (raw as { message?: string; details?: string; hint?: string })?.message ??
      (raw as { details?: string })?.details ??
      (raw as { hint?: string })?.hint ??
      ""
  ).toLowerCase();

  if (normalized.includes("gps fuera de geocerca")) {
    return {
      code: 422,
      message: "Ubicacion fuera del rango permitido para este sitio",
      category: "VALIDATION" as const,
      details: raw,
    };
  }

  if (normalized.includes("ya existe un start abierto")) {
    return {
      code: 409,
      message: "Ya existe una auditoria de inicio abierta para este sitio hoy",
      category: "BUSINESS" as const,
      details: raw,
    };
  }

  if (normalized.includes("supervisora no asignada al restaurante")) {
    return {
      code: 403,
      message: "Sin acceso a este sitio",
      category: "PERMISSION" as const,
      details: raw,
    };
  }

  return {
    code: 409,
    message: "No se pudo registrar presencia",
    category: "BUSINESS" as const,
    details: raw,
  };
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

    // Shared across every action on this endpoint. A full audit signs one upload
    // URL per photo (request_evidence_upload) and may finalize each, then calls
    // register once -- so a 50-evidence audit is ~50-100 requests in one window.
    // 40/60s would 429 mid-audit; 150/60s covers the worst case with headroom.
    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 150, window_seconds: 60 });
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

    // Turn presence rows into what a client can actually render: each evidence
    // carries a signed URL, not just its private storage path (the bucket is
    // private, so a raw path shows as "no photos"). Old audits kept a single photo
    // on the log row itself; fold that in so they aren't left blank either. Emits
    // both `evidences[]` (with signed_url) and `evidence_urls[]` + `evidence_count`
    // so either client convention works.
    const attachSignedEvidence = async (rows: Array<Record<string, unknown>>) => {
      if (!rows.length) return rows;
      const evidenceMap = await fetchEvidences(clientAdmin, rows.map((row) => row.id as number | string));

      const allPaths = new Set<string>();
      for (const list of evidenceMap.values()) {
        for (const item of list) if (item.path) allPaths.add(String(item.path));
      }
      for (const row of rows) if (row.evidence_path) allPaths.add(String(row.evidence_path));

      const signedByPath = new Map<string, string>();
      const paths = [...allPaths];
      if (paths.length > 0) {
        const { data: signed } = await clientAdmin.storage
          .from(evidenceBucket)
          .createSignedUrls(paths, evidenceUrlTtlSeconds);
        (signed ?? []).forEach((entry, i) => {
          if (entry && entry.signedUrl && !entry.error) signedByPath.set(paths[i], entry.signedUrl);
        });
      }

      const isVideo = (mime: unknown) => typeof mime === "string" && mime.toLowerCase().startsWith("video/");

      return rows.map((row) => {
        const list = (evidenceMap.get(String(row.id)) ?? []).map((item) => ({
          ...item,
          signed_url: item.path ? signedByPath.get(String(item.path)) ?? null : null,
          is_video: isVideo(item.mime_type),
        }));

        // Legacy single photo stored directly on the presence log.
        if (row.evidence_path && !list.some((item) => item.path === row.evidence_path)) {
          list.push({
            id: null,
            path: row.evidence_path,
            sha256: row.evidence_hash ?? null,
            mime_type: row.evidence_mime_type ?? null,
            size_bytes: row.evidence_size_bytes ?? null,
            label: null,
            created_at: row.recorded_at ?? null,
            signed_url: signedByPath.get(String(row.evidence_path)) ?? null,
            is_video: isVideo(row.evidence_mime_type),
          });
        }

        return {
          ...row,
          evidences: list,
          evidence_urls: list.map((item) => item.signed_url).filter(Boolean),
          evidence_count: list.length,
        };
      });
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
          max_bytes: maxBytesForMime(payload.mime_type),
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

      const sniffedMime = await detectMimeByMagic(fileBlob);
      if (!allowedMime.has(sniffedMime)) {
        throw { code: 422, message: "MIME no permitido", category: "VALIDATION", details: { sniffedMime } };
      }
      if (fileBlob.size <= 0 || fileBlob.size > maxBytesForMime(sniffedMime)) {
        throw { code: 422, message: "Tamano de archivo invalido", category: "VALIDATION", details: { size: fileBlob.size, mime: sniffedMime } };
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

    if (payload.action === "start") {
      // Create the audit as a DRAFT presence 'start'. The BEFORE INSERT trigger
      // enforces the geofence (arrival). On a double-tap / resume, an open start
      // already exists for today -> return that DRAFT's id instead of erroring.
      const { data, error } = await clientAdmin
        .from("supervisor_presence_logs")
        .insert({
          supervisor_id: user.id,
          restaurant_id: payload.restaurant_id,
          phase: "start",
          status: "draft",
          lat: payload.lat,
          lng: payload.lng,
          recorded_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (error || !data?.id) {
        const norm = String(
          (error as { message?: string; details?: string; hint?: string })?.message ??
            (error as { details?: string })?.details ??
            (error as { hint?: string })?.hint ??
            "",
        ).toLowerCase();
        if (norm.includes("ya existe un start abierto")) {
          // Post-migration 067 the guard only fires when an OPEN DRAFT already
          // exists (double-tap / re-entry) -> return that same draft so the app
          // keeps attaching to it. A completed audit no longer blocks a new one,
          // so inspectors can audit the same site again the same day.
          const { data: openDraft } = await clientAdmin
            .from("supervisor_presence_logs")
            .select("id")
            .eq("supervisor_id", user.id)
            .eq("restaurant_id", payload.restaurant_id)
            .eq("status", "draft")
            .order("recorded_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (openDraft?.id) {
            const successPayload = { success: true, data: { supervision_id: openDraft.id, presence_id: openDraft.id, already_exists: true }, error: null, request_id };
            await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
            return response(true, successPayload.data, null, request_id);
          }
        }
        throw mapPresenceInsertError(error);
      }

      const successPayload = { success: true, data: { supervision_id: data.id, presence_id: data.id, already_exists: false }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "get_active_draft") {
      // Resume support: return the inspector's still-open draft for this restaurant.
      const { data: draft, error } = await clientAdmin
        .from("supervisor_presence_logs")
        .select("id, restaurant_id, lat, lng, recorded_at, notes")
        .eq("supervisor_id", user.id)
        .eq("restaurant_id", payload.restaurant_id)
        .eq("status", "draft")
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw { code: 409, message: "No se pudo consultar el borrador de auditoria", category: "BUSINESS", details: error };
      }
      let evidence_count = 0;
      if (draft?.id) {
        const { count } = await clientAdmin
          .from("supervisor_presence_evidences")
          .select("id", { count: "exact", head: true })
          .eq("presence_id", draft.id);
        evidence_count = count ?? 0;
      }
      const successPayload = {
        success: true,
        data: {
          draft: draft
            ? { supervision_id: draft.id, presence_id: draft.id, restaurant_id: draft.restaurant_id, started_at: draft.recorded_at, notes: draft.notes ?? null, evidence_count }
            : null,
        },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "attach_evidence") {
      // Hang one already-uploaded file on the draft. Ownership + draft-state are
      // checked in code (writes go via service role since the table has no UPDATE
      // RLS policy). mime/size are re-derived here authoritatively.
      const { data: draft, error: draftErr } = await clientAdmin
        .from("supervisor_presence_logs")
        .select("id, supervisor_id, status")
        .eq("id", payload.presence_id)
        .maybeSingle();
      if (draftErr) {
        throw { code: 409, message: "No se pudo validar la auditoria", category: "BUSINESS", details: draftErr };
      }
      if (!draft) {
        throw { code: 404, error_code: "SUPERVISION_NOT_FOUND", message: "Auditoria no encontrada", category: "BUSINESS" };
      }
      if (String(draft.supervisor_id) !== user.id && user.role !== "super_admin") {
        throw { code: 403, error_code: "FORBIDDEN", message: "No puede adjuntar evidencia a una auditoria ajena", category: "PERMISSION" };
      }
      if (draft.status !== "draft") {
        throw { code: 409, error_code: "SUPERVISION_NOT_DRAFT", message: "La auditoria ya fue finalizada", category: "BUSINESS" };
      }

      const { count: currentCount } = await clientAdmin
        .from("supervisor_presence_evidences")
        .select("id", { count: "exact", head: true })
        .eq("presence_id", payload.presence_id);
      if ((currentCount ?? 0) >= MAX_SUPERVISION_EVIDENCES) {
        throw { code: 409, error_code: "EVIDENCE_LIMIT_REACHED", message: `Limite de ${MAX_SUPERVISION_EVIDENCES} evidencias alcanzado`, category: "BUSINESS", details: { limit: MAX_SUPERVISION_EVIDENCES } };
      }

      assertSupervisorPath(payload.path);
      const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(evidenceBucket).download(payload.path);
      if (downloadError || !fileBlob) {
        throw { code: 422, message: "Evidencia no disponible en storage", category: "VALIDATION", details: downloadError };
      }
      const sniffedMime = await detectMimeByMagic(fileBlob);
      if (!allowedMime.has(sniffedMime)) {
        throw { code: 422, error_code: "MIME_NOT_ALLOWED", message: "MIME no permitido", category: "VALIDATION", details: { sniffedMime } };
      }
      if (fileBlob.size <= 0 || fileBlob.size > maxBytesForMime(sniffedMime)) {
        throw { code: 422, error_code: "SIZE_INVALID", message: "Tamano de evidencia invalido", category: "VALIDATION", details: { size: fileBlob.size, mime: sniffedMime } };
      }
      const sha256 = await sha256Hex(fileBlob);

      const { data: inserted, error: insErr } = await clientAdmin
        .from("supervisor_presence_evidences")
        .insert({
          presence_id: payload.presence_id,
          storage_path: payload.path,
          sha256,
          mime_type: sniffedMime,
          size_bytes: fileBlob.size,
          label: payload.label ?? null,
          meta: payload.meta ?? null,
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (insErr || !inserted?.id) {
        throw { code: 409, message: "No se pudo adjuntar la evidencia", category: "BUSINESS", details: insErr };
      }

      const successPayload = {
        success: true,
        data: { evidence_id: inserted.id, presence_id: payload.presence_id, mime_type: sniffedMime, size_bytes: fileBlob.size, evidence_count: (currentCount ?? 0) + 1 },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "finalize") {
      // Draft -> completed. Only metadata (notes); no photos (they arrived via
      // attach_evidence). No geofence revalidation. Idempotent.
      const { data: draft, error: draftErr } = await clientAdmin
        .from("supervisor_presence_logs")
        .select("id, supervisor_id, status")
        .eq("id", payload.presence_id)
        .maybeSingle();
      if (draftErr) {
        throw { code: 409, message: "No se pudo validar la auditoria", category: "BUSINESS", details: draftErr };
      }
      if (!draft) {
        throw { code: 404, error_code: "SUPERVISION_NOT_FOUND", message: "Auditoria no encontrada", category: "BUSINESS" };
      }
      if (String(draft.supervisor_id) !== user.id && user.role !== "super_admin") {
        throw { code: 403, error_code: "FORBIDDEN", message: "No puede finalizar una auditoria ajena", category: "PERMISSION" };
      }
      if (draft.status === "completed") {
        const successPayload = { success: true, data: { supervision_id: draft.id, presence_id: draft.id, already_completed: true }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
        return response(true, successPayload.data, null, request_id);
      }

      // Mirror the first attached evidence onto the log's primary columns (list
      // views read these for the card thumbnail).
      const { data: firstEv } = await clientAdmin
        .from("supervisor_presence_evidences")
        .select("storage_path, sha256, mime_type, size_bytes")
        .eq("presence_id", draft.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      const patch: Record<string, unknown> = { status: "completed" };
      if (payload.notes !== undefined) patch.notes = payload.notes ?? null;
      if (firstEv?.storage_path) {
        patch.evidence_path = firstEv.storage_path;
        patch.evidence_hash = firstEv.sha256;
        patch.evidence_mime_type = firstEv.mime_type;
        patch.evidence_size_bytes = firstEv.size_bytes;
      }

      const { error: updErr } = await clientAdmin
        .from("supervisor_presence_logs")
        .update(patch)
        .eq("id", draft.id)
        .eq("status", "draft");
      if (updErr) {
        throw { code: 409, message: "No se pudo finalizar la auditoria", category: "BUSINESS", details: updErr };
      }

      await safeWriteAudit({ user_id: user.id, action: "SUPERVISOR_PRESENCE_FINALIZE", context: { presence_id: draft.id }, request_id });

      const successPayload = { success: true, data: { supervision_id: draft.id, presence_id: draft.id, already_completed: false }, error: null, request_id };
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
      const withEvidence = await attachSignedEvidence(items);
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
        throw { code: 409, message: "No se pudo listar auditorias por sitio", category: "BUSINESS", details: error };
      }

      const items = data ?? [];
      const withEvidence = await attachSignedEvidence(items);
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

      const items = await attachSignedEvidence(baseItems);

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "register") {
      await ensureActiveRestaurant(payload.restaurant_id);
      try {
        await geoValidatorByRestaurant(clientAdmin, payload.restaurant_id, payload.lat, payload.lng, {
          settings,
          accuracy: payload.accuracy,
        });
      } catch (geoError) {
        const geoMessage = String((geoError as { message?: string })?.message ?? "").toLowerCase();
        if (geoMessage.includes("gps fuera de radio")) {
          throw {
            code: 422,
            message: "Ubicacion fuera del rango permitido para este sitio",
            category: "VALIDATION",
            details: geoError,
          };
        }
        throw geoError;
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

      // Download + sniff + hash each evidence. This is the real cost of a large
      // audit, so run it with bounded concurrency (files are images <= 8 MB, so a
      // handful in flight keeps memory small while cutting wall-clock ~Nx).
      // Results are written back by index to preserve order (primaryEvidence is
      // the first one).
      const normalizeOne = async (evidence: typeof evidences[number]) => {
        assertSupervisorPath(evidence.path, payload.phase);
        const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(evidenceBucket).download(evidence.path);
        if (downloadError || !fileBlob) {
          throw { code: 422, message: "Evidencia no disponible en storage", category: "VALIDATION", details: downloadError };
        }

        const sniffedMime = await detectMimeByMagic(fileBlob);
        if (!allowedMime.has(sniffedMime)) {
          throw { code: 422, message: "MIME no permitido", category: "VALIDATION", details: { sniffedMime } };
        }
        if (fileBlob.size <= 0 || fileBlob.size > maxBytesForMime(sniffedMime)) {
          throw { code: 422, message: "Tamano de evidencia invalido", category: "VALIDATION", details: { size: fileBlob.size, mime: sniffedMime } };
        }

        const sha256 = await sha256Hex(fileBlob);
        return {
          storage_path: evidence.path,
          sha256,
          mime_type: sniffedMime,
          size_bytes: fileBlob.size,
          label: evidence.label ?? null,
        };
      };

      normalizedEvidences.length = evidences.length;
      // Videos are large (up to 50 MB) and each is fully loaded into memory to
      // hash it, so drop the fan-out when the batch contains any video to bound
      // peak memory; image-only audits keep the higher concurrency.
      const batchHasVideo = evidences.some((e) => {
        const m = (e.mime_type ?? "").toLowerCase();
        return m.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(e.path);
      });
      const EVIDENCE_CONCURRENCY = batchHasVideo ? 2 : 6;
      let nextEvidenceIdx = 0;
      const evidenceWorker = async () => {
        while (true) {
          const i = nextEvidenceIdx++;
          if (i >= evidences.length) break;
          normalizedEvidences[i] = await normalizeOne(evidences[i]);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(EVIDENCE_CONCURRENCY, evidences.length) }, () => evidenceWorker()),
      );

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
        const normalizedInsertError = String(
          (error as { message?: string; details?: string; hint?: string })?.message ??
            (error as { details?: string })?.details ??
            (error as { hint?: string })?.hint ??
            "",
        ).toLowerCase();

        if (payload.phase === "start" && normalizedInsertError.includes("ya existe un start abierto")) {
          const existing = await findOpenStartPresenceForUtcDay(insertClient, user.id, payload.restaurant_id);
          if (existing?.id) {
            const successPayload = {
              success: true,
              data: {
                presence_id: existing.id,
                already_exists: true,
              },
              error: null,
              request_id,
            };

            await safeFinalizeIdempotency({
              userId: user.id,
              endpoint,
              key: idempotencyKey,
              statusCode: 200,
              responseBody: successPayload,
            });
            return response(true, successPayload.data, null, request_id);
          }
        }

        throw mapPresenceInsertError(error);
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
