// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { ensureSupervisorRestaurantAccess } from "../_shared/scopeGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "supervisor_presence_manage";

const registerAction = z.object({
  action: z.literal("register"),
  restaurant_id: z.number().int().positive(),
  phase: z.enum(["start", "end"]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  evidence_path: z.string().min(5).max(500),
  evidence_hash: z.string().min(16).max(200),
  evidence_mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  evidence_size_bytes: z.number().int().positive().max(50000000),
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
});

const listTodayAction = z.object({
  action: z.literal("list_today"),
  limit: z.number().int().min(1).max(500).default(20),
});

const payloadSchema = z.discriminatedUnion("action", [registerAction, listMyAction, listByRestaurantAction, listTodayAction]);

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

    if (payload.action === "list_my") {
      const { data, error } = await clientUser
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

      const successPayload = { success: true, data: { items: data ?? [] }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_by_restaurant") {
      roleGuard(user, ["supervisora", "super_admin"]);

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
      }

      const { data, error } = await clientUser
        .from("supervisor_presence_logs")
        .select(
          "id, supervisor_id, restaurant_id, phase, lat, lng, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, recorded_at, notes"
        )
        .eq("restaurant_id", payload.restaurant_id)
        .order("recorded_at", { ascending: false })
        .limit(payload.limit);

      if (error) {
        throw { code: 409, message: "No se pudo listar presencia por restaurante", category: "BUSINESS", details: error };
      }

      const successPayload = { success: true, data: { items: data ?? [] }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_today") {
      roleGuard(user, ["super_admin"]);
      const { startIso, endIso } = getBogotaDayRange();

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

      const items = (data ?? []).map((row) => {
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

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "register") {
      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
      }

      const { data, error } = await clientUser
        .from("supervisor_presence_logs")
        .insert({
          supervisor_id: user.id,
          restaurant_id: payload.restaurant_id,
          phase: payload.phase,
          lat: payload.lat,
          lng: payload.lng,
          evidence_path: payload.evidence_path,
          evidence_hash: payload.evidence_hash,
          evidence_mime_type: payload.evidence_mime_type,
          evidence_size_bytes: payload.evidence_size_bytes,
          notes: payload.notes ?? null,
          recorded_at: new Date().toISOString(),
        })
        .select("id")
        .single();

      if (error || !data?.id) {
        throw { code: 409, message: "No se pudo registrar presencia", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SUPERVISOR_PRESENCE_REGISTER",
        context: {
          presence_id: data.id,
          restaurant_id: payload.restaurant_id,
          phase: payload.phase,
          evidence_path: payload.evidence_path,
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
