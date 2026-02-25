import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { getOwnedShift, ensureShiftState, ensureEvidenceNotDuplicate } from "../_shared/stateValidator.ts";
import { geoValidatorByShift } from "../_shared/geoValidator.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "evidence_upload";
const bucket = "shift-evidence";
const maxBytes = 8 * 1024 * 1024;
const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);

const requestUploadSchema = z.object({
  action: z.literal("request_upload"),
  shift_id: commonSchemas.shiftId,
  type: commonSchemas.photoType,
});

const finalizeUploadSchema = z.object({
  action: z.literal("finalize_upload"),
  shift_id: commonSchemas.shiftId,
  type: commonSchemas.photoType,
  path: z.string().min(10).max(500),
  lat: commonSchemas.lat,
  lng: commonSchemas.lng,
  accuracy: commonSchemas.accuracy,
  captured_at: commonSchemas.capturedAt,
});

const payloadSchema = z.discriminatedUnion("action", [requestUploadSchema, finalizeUploadSchema]);

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

serve(async (req) => {
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
    roleGuard(user, ["empleado"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 20, window_seconds: 60 });

    if (payload.action === "request_upload") {
      const shift = await getOwnedShift(clientUser, user.id, payload.shift_id);
      ensureShiftState(shift.state, ["activo", "finalizado"], "No se puede cargar evidencia en este estado");
      await ensureEvidenceNotDuplicate(clientUser, payload.shift_id, payload.type);

      const path = `${user.id}/${payload.shift_id}/${payload.type}/${request_id}.bin`;
      const { data, error } = await clientAdmin.storage.from(bucket).createSignedUploadUrl(path);
      if (error || !data) {
        throw { code: 500, message: "No se pudo generar URL de carga", category: "SYSTEM", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "EVIDENCE_UPLOAD_REQUEST",
        context: { shift_id: payload.shift_id, type: payload.type, path },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          upload: data,
          bucket,
          path,
          max_bytes: maxBytes,
          allowed_mime: [...allowedMime],
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

      return response(true, successPayload.data, null, request_id);
    }

    const shift = await getOwnedShift(clientUser, user.id, payload.shift_id);
    ensureShiftState(shift.state, ["activo", "finalizado"], "No se puede cargar evidencia en este estado");
    await ensureEvidenceNotDuplicate(clientUser, payload.shift_id, payload.type);
    await geoValidatorByShift(clientUser, payload.shift_id, payload.lat, payload.lng);

    const expectedPrefix = `${user.id}/${payload.shift_id}/${payload.type}/`;
    if (!payload.path.startsWith(expectedPrefix)) {
      throw { code: 403, message: "Ruta de evidencia invalida", category: "PERMISSION" };
    }

    const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(bucket).download(payload.path);
    if (downloadError || !fileBlob) {
      throw { code: 422, message: "Archivo no disponible en storage", category: "VALIDATION", details: downloadError };
    }

    if (fileBlob.size <= 0 || fileBlob.size > maxBytes) {
      throw { code: 422, message: "Tamano de archivo invalido", category: "VALIDATION", details: { size: fileBlob.size } };
    }

    const sniffedMime = await detectMimeByMagic(fileBlob);
    if (!allowedMime.has(sniffedMime)) {
      throw { code: 422, message: "MIME no permitido", category: "VALIDATION", details: { sniffedMime } };
    }

    const sha256 = await sha256Hex(fileBlob);
    const storageUrl = `storage://${bucket}/${payload.path}`;

    const { error: insertError } = await clientUser.from("shift_photos").insert({
      shift_id: payload.shift_id,
      user_id: user.id,
      url: storageUrl,
      storage_path: payload.path,
      type: payload.type,
      taken_at: new Date().toISOString(),
      captured_at: payload.captured_at,
      lat: payload.lat,
      lng: payload.lng,
      accuracy: payload.accuracy,
      sha256,
      mime_type: sniffedMime,
      file_size: fileBlob.size,
      created_at: new Date().toISOString(),
    });

    if (insertError) {
      throw { code: 409, message: "No se pudo registrar evidencia", category: "BUSINESS", details: insertError };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "EVIDENCE_UPLOAD_FINALIZE",
      context: {
        shift_id: payload.shift_id,
        type: payload.type,
        storage_path: payload.path,
        sha256,
        mime_type: sniffedMime,
        file_size: fileBlob.size,
      },
      request_id,
    });

    const successPayload = {
      success: true,
      data: {
        shift_id: payload.shift_id,
        type: payload.type,
        storage_path: payload.path,
        sha256,
      },
      error: null,
      request_id,
    };

    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, successPayload.data, null, request_id);
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

