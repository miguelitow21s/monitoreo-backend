import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { ensureSupervisorRestaurantAccess } from "../_shared/scopeGuard.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "supplies_deliver";
const deliverSchema = z.object({
  supply_id: commonSchemas.supplyId,
  restaurant_id: commonSchemas.restaurantId,
  quantity: commonSchemas.quantity,
});

const deliverActionSchema = deliverSchema.extend({
  action: z.literal("deliver"),
});

const listSuppliesSchema = z.object({
  action: z.literal("list_supplies"),
  restaurant_id: commonSchemas.restaurantId.optional(),
  limit: z.number().int().min(1).max(500).default(200),
  search: z.string().trim().min(1).max(120).optional(),
});

const listDeliveriesSchema = z.object({
  action: z.literal("list_deliveries"),
  restaurant_id: commonSchemas.restaurantId.optional(),
  delivered_by: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

const payloadSchema = z.union([deliverActionSchema, listSuppliesSchema, listDeliveriesSchema, deliverSchema]);

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
    roleGuard(user, ["supervisora", "super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 30, window_seconds: 60 });

    if ("action" in payload) {
      if (payload.action === "list_supplies") {
        if (user.role === "supervisora" && !payload.restaurant_id) {
          throw { code: 422, message: "Restaurant requerido para supervisora", category: "VALIDATION" };
        }

        if (user.role === "supervisora" && payload.restaurant_id) {
          await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
        }

        let query = clientUser
          .from("supplies")
          .select("id, name, unit, stock, restaurant_id, unit_cost, created_at")
          .order("name", { ascending: true })
          .limit(payload.limit);

        if (payload.restaurant_id) {
          query = query.eq("restaurant_id", payload.restaurant_id);
        }

        if (payload.search) {
          query = query.ilike("name", `%${payload.search}%`);
        }

        const { data, error } = await query;
        if (error) {
          throw { code: 409, message: "No se pudo listar insumos", category: "BUSINESS", details: error };
        }

        const successPayload = { success: true, data: { items: data ?? [] }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
        return response(true, successPayload.data, null, request_id);
      }

      if (payload.action === "list_deliveries") {
        if (user.role === "supervisora" && !payload.restaurant_id) {
          throw { code: 422, message: "Restaurant requerido para supervisora", category: "VALIDATION" };
        }

        if (user.role === "supervisora" && payload.restaurant_id) {
          await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
        }

        let query = clientUser
          .from("supply_deliveries")
          .select("id, supply_id, restaurant_id, quantity, delivered_at, delivered_by, status_v2, supplies(name, unit, unit_cost)")
          .order("delivered_at", { ascending: false })
          .limit(payload.limit);

        if (payload.restaurant_id) {
          query = query.eq("restaurant_id", payload.restaurant_id);
        }

        if (payload.delivered_by) {
          query = query.eq("delivered_by", payload.delivered_by);
        }

        const { data, error } = await query;
        if (error) {
          throw { code: 409, message: "No se pudo listar entregas de insumos", category: "BUSINESS", details: error };
        }

        const successPayload = { success: true, data: { items: data ?? [] }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
        return response(true, successPayload.data, null, request_id);
      }
    }

    const { supply_id, restaurant_id, quantity } = payload as z.infer<typeof deliverSchema>;
    if (user.role === "supervisora") {
      await ensureSupervisorRestaurantAccess(user.id, restaurant_id);
    }

    const { data, error } = await clientUser
      .from("supply_deliveries")
      .insert({
        supply_id,
        restaurant_id,
        quantity,
        delivered_at: new Date().toISOString(),
        delivered_by: user.id,
      })
      .select("id")
      .single();

    if (error || !data) {
      throw { code: 409, message: "No se pudo registrar entrega", category: "BUSINESS", details: error };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "SUPPLY_DELIVERY",
      context: { delivery_id: data.id, supply_id, restaurant_id, quantity },
      request_id,
    });

    const successPayload = { success: true, data: { delivery_id: data.id }, error: null, request_id };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, { delivery_id: data.id }, null, request_id);
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

