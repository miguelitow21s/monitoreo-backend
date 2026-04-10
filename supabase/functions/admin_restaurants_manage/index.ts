// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "admin_restaurants_manage";

type AppRole = "super_admin" | "supervisora" | "empleado";

const cleaningAreaSchema = z
  .object({
    code: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(120),
    active: z.boolean().optional(),
  })
  .strict();

const cleaningAreaGroupSchema = z
  .object({
    area: z.string().trim().min(1).max(120),
    subareas: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  })
  .strict();

const cleaningAreaItemSchema = z.union([
  cleaningAreaSchema,
  cleaningAreaGroupSchema,
  z.string().trim().min(1).max(120),
]);

const createAction = z.object({
  action: z.literal("create"),
  name: z.string().trim().min(2).max(160),
  lat: commonSchemas.lat,
  lng: commonSchemas.lng,
  radius: z.number().int().min(1).max(20000),
  address_line: z.string().trim().max(250).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  postal_code: z.string().trim().max(40).optional().nullable(),
  country: z.string().trim().max(120).optional().nullable(),
  place_id: z.string().trim().max(250).optional().nullable(),
  is_active: z.boolean().optional(),
  cleaning_areas: z.array(cleaningAreaItemSchema).max(200).optional(),
});

const updateAction = z.object({
  action: z.literal("update"),
  restaurant_id: commonSchemas.restaurantId,
  name: z.string().trim().min(2).max(160).optional(),
  lat: commonSchemas.lat.optional(),
  lng: commonSchemas.lng.optional(),
  radius: z.number().int().min(1).max(20000).optional(),
  address_line: z.string().trim().max(250).optional().nullable(),
  city: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().max(120).optional().nullable(),
  postal_code: z.string().trim().max(40).optional().nullable(),
  country: z.string().trim().max(120).optional().nullable(),
  place_id: z.string().trim().max(250).optional().nullable(),
  is_active: z.boolean().optional(),
  cleaning_areas: z.array(cleaningAreaItemSchema).max(200).optional().nullable(),
});

const activateAction = z.object({
  action: z.literal("activate"),
  restaurant_id: commonSchemas.restaurantId,
});

const deactivateAction = z.object({
  action: z.literal("deactivate"),
  restaurant_id: commonSchemas.restaurantId,
});

const listAction = z.object({
  action: z.literal("list"),
  is_active: z.boolean().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

const payloadSchema = z.discriminatedUnion("action", [
  createAction,
  updateAction,
  activateAction,
  deactivateAction,
  listAction,
]);

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
  let userRole: AppRole | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    if (payload.action === "create" || payload.action === "list" || payload.action === "deactivate") {
      roleGuard(user, ["super_admin", "supervisora"]);
    } else {
      roleGuard(user, ["super_admin"]);
    }
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 40, window_seconds: 60 });

    if (payload.action === "create") {
      const now = new Date().toISOString();
      const insertClient = user.role === "supervisora" ? clientAdmin : clientUser;
      const { data, error } = await insertClient
        .from("restaurants")
        .insert({
          name: payload.name,
          lat: payload.lat,
          lng: payload.lng,
          radius: payload.radius,
          geofence_radius_m: payload.radius,
          address_line: payload.address_line ?? null,
          city: payload.city ?? null,
          state: payload.state ?? null,
          postal_code: payload.postal_code ?? null,
          country: payload.country ?? null,
          place_id: payload.place_id ?? null,
          is_active: payload.is_active ?? true,
          cleaning_areas: payload.cleaning_areas ?? null,
          updated_at: now,
        })
        .select("id, name, lat, lng, radius, geofence_radius_m, is_active, address_line, city, state, postal_code, country, place_id, cleaning_areas, created_at, updated_at")
        .single();

      if (error || !data) {
        throw { code: 409, message: "No se pudo crear restaurante", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "ADMIN_RESTAURANT_CREATE",
        context: { restaurant_id: data.id, name: data.name, is_active: data.is_active },
        request_id,
      });

      const successPayload = { success: true, data: { restaurant: data }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "update") {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (payload.name !== undefined) patch.name = payload.name;
      if (payload.lat !== undefined) patch.lat = payload.lat;
      if (payload.lng !== undefined) patch.lng = payload.lng;
      if (payload.radius !== undefined) {
        patch.radius = payload.radius;
        patch.geofence_radius_m = payload.radius;
      }
      if (payload.address_line !== undefined) patch.address_line = payload.address_line ?? null;
      if (payload.city !== undefined) patch.city = payload.city ?? null;
      if (payload.state !== undefined) patch.state = payload.state ?? null;
      if (payload.postal_code !== undefined) patch.postal_code = payload.postal_code ?? null;
      if (payload.country !== undefined) patch.country = payload.country ?? null;
      if (payload.place_id !== undefined) patch.place_id = payload.place_id ?? null;
      if (payload.is_active !== undefined) patch.is_active = payload.is_active;
      if (payload.cleaning_areas !== undefined) patch.cleaning_areas = payload.cleaning_areas ?? null;

      const { data, error } = await clientUser
        .from("restaurants")
        .update(patch)
        .eq("id", payload.restaurant_id)
        .select("id, name, lat, lng, radius, geofence_radius_m, is_active, address_line, city, state, postal_code, country, place_id, cleaning_areas, created_at, updated_at")
        .single();

      if (error || !data) {
        throw { code: 409, message: "No se pudo actualizar restaurante", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "ADMIN_RESTAURANT_UPDATE",
        context: { restaurant_id: payload.restaurant_id, fields: Object.keys(patch) },
        request_id,
      });

      const successPayload = { success: true, data: { restaurant: data }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "activate" || payload.action === "deactivate") {
      const isActive = payload.action === "activate";
      const statusClient = user.role === "supervisora" && payload.action === "deactivate" ? clientAdmin : clientUser;
      const { data, error } = await statusClient
        .from("restaurants")
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq("id", payload.restaurant_id)
        .select("id, name, lat, lng, radius, geofence_radius_m, is_active, address_line, city, state, postal_code, country, place_id, cleaning_areas, created_at, updated_at")
        .single();

      if (error || !data) {
        throw { code: 409, message: "No se pudo cambiar estado de restaurante", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: isActive ? "ADMIN_RESTAURANT_ACTIVATE" : "ADMIN_RESTAURANT_DEACTIVATE",
        context: { restaurant_id: payload.restaurant_id },
        request_id,
      });

      const successPayload = { success: true, data: { restaurant: data }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    const listClient = user.role === "supervisora" ? clientAdmin : clientUser;
    let query = listClient
      .from("restaurants")
      .select("id, name, lat, lng, radius, geofence_radius_m, is_active, address_line, city, state, postal_code, country, place_id, cleaning_areas, created_at, updated_at")
      .order("name", { ascending: true });

    if (payload.is_active !== undefined) query = query.eq("is_active", payload.is_active);

    const searchRaw = payload.search?.trim();
    if (searchRaw) {
      const term = searchRaw.replace(/,/g, " ");
      query = query.or(`name.ilike.%${term}%,city.ilike.%${term}%,state.ilike.%${term}%`);
    }

    query = query.limit(payload.limit);

    const { data, error } = await query;
    if (error) {
      throw { code: 409, message: "No se pudo listar restaurantes", category: "BUSINESS", details: error };
    }

    const items = (data ?? []) as Array<Record<string, unknown>>;

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
