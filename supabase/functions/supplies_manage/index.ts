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
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "supplies_manage";

const listAction = z.object({
  action: z.literal("list"),
  restaurant_id: commonSchemas.restaurantId.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

const createAction = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(2).max(200),
  unit: z.string().trim().min(1).max(50),
  restaurant_id: commonSchemas.restaurantId,
  stock: z.number().int().min(0).max(100000).default(0),
  unit_cost: z.number().min(0).max(1000000).default(0),
});

const updateAction = z.object({
  action: z.literal("update"),
  supply_id: commonSchemas.supplyId,
  name: z.string().trim().min(2).max(200).optional(),
  unit: z.string().trim().min(1).max(50).optional(),
  restaurant_id: commonSchemas.restaurantId.optional(),
  stock: z.number().int().min(0).max(100000).optional(),
  unit_cost: z.number().min(0).max(1000000).optional(),
});

const payloadSchema = z.discriminatedUnion("action", [listAction, createAction, updateAction]);

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

    if (payload.action === "create") {
      roleGuard(user, ["super_admin"]);

      const { data, error } = await clientAdmin
        .from("supplies")
        .insert({
          name: payload.name,
          unit: payload.unit,
          stock: payload.stock,
          restaurant_id: payload.restaurant_id,
          unit_cost: payload.unit_cost,
        })
        .select("id")
        .single();

      if (error || !data) {
        throw { code: 409, message: "No se pudo crear suministro", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SUPPLY_CREATE",
        context: {
          supply_id: data.id,
          restaurant_id: payload.restaurant_id,
        },
        request_id,
      });

      const successPayload = { success: true, data: { supply_id: data.id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "update") {
      roleGuard(user, ["super_admin"]);

      const updates: Record<string, unknown> = {};
      if (payload.name !== undefined) updates.name = payload.name;
      if (payload.unit !== undefined) updates.unit = payload.unit;
      if (payload.stock !== undefined) updates.stock = payload.stock;
      if (payload.unit_cost !== undefined) updates.unit_cost = payload.unit_cost;
      if (payload.restaurant_id !== undefined) updates.restaurant_id = payload.restaurant_id;

      if (Object.keys(updates).length === 0) {
        throw { code: 422, message: "No hay campos para actualizar", category: "VALIDATION" };
      }

      const { error } = await clientAdmin.from("supplies").update(updates).eq("id", payload.supply_id);
      if (error) {
        throw { code: 409, message: "No se pudo actualizar suministro", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SUPPLY_UPDATE",
        context: { supply_id: payload.supply_id },
        request_id,
      });

      const successPayload = { success: true, data: { supply_id: payload.supply_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    roleGuard(user, ["super_admin", "supervisora"]);

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
      .from("supplies")
      .select("id, name, unit, stock, unit_cost, restaurant_id, created_at")
      .order("name", { ascending: true })
      .limit(payload.limit);

    if (restaurantIds && restaurantIds.length > 0) {
      query = query.in("restaurant_id", restaurantIds);
    }

    const { data: supplies, error: suppliesError } = await query;
    if (suppliesError) {
      throw { code: 409, message: "No se pudieron listar suministros", category: "BUSINESS", details: suppliesError };
    }

    const successPayload = { success: true, data: { items: supplies ?? [] }, error: null, request_id };
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
