// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { ensureSupervisorRestaurantAccess } from "../_shared/scopeGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "shifts_manage";

const getMyActiveAction = z.object({
  action: z.literal("get_my_active"),
});

const listActiveAction = z.object({
  action: z.literal("list_active"),
  restaurant_id: commonSchemas.restaurantId.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

const payloadSchema = z.discriminatedUnion("action", [getMyActiveAction, listActiveAction]);

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
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
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

    if (payload.action === "get_my_active") {
      const { data: activeShift, error: activeShiftError } = await clientAdmin
        .from("shifts")
        .select("id, employee_id, restaurant_id, start_time, end_time, state")
        .eq("employee_id", user.id)
        .eq("state", "activo")
        .order("start_time", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeShiftError) {
        throw { code: 409, message: "No se pudo consultar turno activo", category: "BUSINESS", details: activeShiftError };
      }

      const successPayload = { success: true, data: activeShift ?? null, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    roleGuard(user, ["supervisora", "super_admin"]);

    let restaurantIds: number[] | null = null;
    if (payload.restaurant_id) {
      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
      }
      restaurantIds = [payload.restaurant_id];
    } else if (user.role === "supervisora") {
      const { data: scopeLinks, error: scopeError } = await clientAdmin
        .from("restaurant_employees")
        .select("restaurant_id")
        .eq("user_id", user.id);

      if (scopeError) {
        throw { code: 409, message: "No se pudo resolver alcance de supervisora", category: "BUSINESS", details: scopeError };
      }

      restaurantIds = [...new Set((scopeLinks ?? []).map((row) => Number(row.restaurant_id)).filter((n) => Number.isFinite(n)))];
      if (restaurantIds.length === 0) {
        const emptyPayload = { success: true, data: { items: [] }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: emptyPayload });
        return response(true, emptyPayload.data, null, request_id);
      }
    }

    let query = clientAdmin
      .from("shifts")
      .select("id, employee_id, restaurant_id, start_time, end_time, state")
      .eq("state", "activo")
      .order("start_time", { ascending: false })
      .limit(payload.limit);

    if (restaurantIds && restaurantIds.length > 0) {
      query = query.in("restaurant_id", restaurantIds);
    }

    const { data: shifts, error: shiftsError } = await query;
    if (shiftsError) {
      throw { code: 409, message: "No se pudieron listar turnos activos", category: "BUSINESS", details: shiftsError };
    }

    const shiftIds = (shifts ?? []).map((s) => Number(s.id)).filter((n) => Number.isFinite(n));
    let evidenceByShift = new Map<number, { inicio?: string; fin?: string }>();
    if (shiftIds.length > 0) {
      const { data: photos, error: photosError } = await clientAdmin
        .from("shift_photos")
        .select("shift_id, type, storage_path, created_at")
        .in("shift_id", shiftIds)
        .in("type", ["inicio", "fin"])
        .order("created_at", { ascending: true });

      if (photosError) {
        throw { code: 409, message: "No se pudieron cargar evidencias", category: "BUSINESS", details: photosError };
      }

      for (const row of photos ?? []) {
        const shiftId = Number(row.shift_id);
        if (!evidenceByShift.has(shiftId)) evidenceByShift.set(shiftId, {});
        const entry = evidenceByShift.get(shiftId)!;
        if (row.type === "inicio" && !entry.inicio) entry.inicio = row.storage_path ?? row.path ?? null;
        if (row.type === "fin" && !entry.fin) entry.fin = row.storage_path ?? row.path ?? null;
      }
    }

    const items = (shifts ?? []).map((row) => {
      const evidence = evidenceByShift.get(Number(row.id)) ?? {};
      return {
        id: row.id,
        employee_id: row.employee_id,
        restaurant_id: row.restaurant_id,
        start_time: row.start_time,
        end_time: row.end_time,
        status: row.state,
        start_evidence_path: evidence.inicio ?? null,
        end_evidence_path: evidence.fin ?? null,
      };
    });

    const successPayload = { success: true, data: { items }, error: null, request_id };
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
