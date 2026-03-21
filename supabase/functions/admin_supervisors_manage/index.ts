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

const endpoint = "admin_supervisors_manage";

type AppRole = "super_admin" | "supervisora" | "empleado";

const assignAction = z.object({
  action: z.literal("assign"),
  supervisor_id: z.string().uuid(),
  restaurant_id: commonSchemas.restaurantId,
});

const unassignAction = z.object({
  action: z.literal("unassign"),
  supervisor_id: z.string().uuid(),
  restaurant_id: commonSchemas.restaurantId,
});

const listByRestaurantAction = z.object({
  action: z.literal("list_by_restaurant"),
  restaurant_id: commonSchemas.restaurantId,
});

const listBySupervisorAction = z.object({
  action: z.literal("list_by_supervisor"),
  supervisor_id: z.string().uuid(),
});

const payloadSchema = z.discriminatedUnion("action", [
  assignAction,
  unassignAction,
  listByRestaurantAction,
  listBySupervisorAction,
]);

async function ensureSupervisorUser(supervisorId: string) {
  const { data, error } = await clientAdmin
    .from("profiles")
    .select("id, role, is_active, email, first_name, last_name, full_name")
    .eq("id", supervisorId)
    .single();

  if (error || !data) {
    throw { code: 404, message: "Supervisora no encontrada", category: "BUSINESS", details: error };
  }

  if (String(data.role) !== "supervisora") {
    throw { code: 422, message: "El usuario no tiene rol supervisora", category: "VALIDATION" };
  }

  if (data.is_active === false) {
    throw { code: 422, message: "No se puede asignar una supervisora inactiva", category: "VALIDATION" };
  }

  return data;
}

async function ensureRestaurant(restaurantId: number) {
  const { data, error } = await clientAdmin
    .from("restaurants")
    .select("id, name, is_active")
    .eq("id", restaurantId)
    .single();

  if (error || !data) {
    throw { code: 404, message: "Restaurante no encontrado", category: "BUSINESS", details: error };
  }

  return data;
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
  let userRole: AppRole | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 50, window_seconds: 60 });

    if (payload.action === "assign") {
      const supervisor = await ensureSupervisorUser(payload.supervisor_id);
      const restaurant = await ensureRestaurant(payload.restaurant_id);
      if (restaurant.is_active === false) {
        throw { code: 422, message: "No se puede asignar supervisora a restaurante inactivo", category: "VALIDATION" };
      }

      const { error } = await clientUser
        .from("restaurant_employees")
        .upsert(
          {
            restaurant_id: payload.restaurant_id,
            user_id: payload.supervisor_id,
          },
          { onConflict: "restaurant_id,user_id" }
        );

      if (error) {
        throw { code: 409, message: "No se pudo asignar supervisora", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "ADMIN_SUPERVISOR_ASSIGN",
        context: {
          supervisor_id: payload.supervisor_id,
          supervisor_email: supervisor.email,
          restaurant_id: payload.restaurant_id,
          restaurant_name: restaurant.name,
        },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          assignment: {
            supervisor_id: payload.supervisor_id,
            restaurant_id: payload.restaurant_id,
          },
        },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "unassign") {
      const { error } = await clientUser
        .from("restaurant_employees")
        .delete()
        .eq("restaurant_id", payload.restaurant_id)
        .eq("user_id", payload.supervisor_id);

      if (error) {
        throw { code: 409, message: "No se pudo desasignar supervisora", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "ADMIN_SUPERVISOR_UNASSIGN",
        context: {
          supervisor_id: payload.supervisor_id,
          restaurant_id: payload.restaurant_id,
        },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          assignment: {
            supervisor_id: payload.supervisor_id,
            restaurant_id: payload.restaurant_id,
          },
        },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_by_restaurant") {
      const { data: links, error: linksError } = await clientAdmin
        .from("restaurant_employees")
        .select("user_id, created_at")
        .eq("restaurant_id", payload.restaurant_id)
        .order("created_at", { ascending: false });

      if (linksError) {
        throw { code: 409, message: "No se pudo listar asignaciones de supervisora", category: "BUSINESS", details: linksError };
      }

      const supervisorIds = [...new Set((links ?? []).map((x) => String(x.user_id)))];
      const { data: profiles, error: profilesError } = supervisorIds.length
        ? await clientAdmin
            .from("profiles")
            .select("id, first_name, last_name, full_name, email, role, is_active")
            .in("id", supervisorIds)
            .eq("role", "supervisora")
        : { data: [], error: null };

      if (profilesError) {
        throw { code: 409, message: "No se pudieron cargar supervisoras", category: "BUSINESS", details: profilesError };
      }

      const byId = new Map((profiles ?? []).map((p) => [String(p.id), p]));
      const items = (links ?? [])
        .map((row) => {
          const profile = byId.get(String(row.user_id));
          if (!profile) return null;
          return {
            supervisor_id: row.user_id,
            assigned_at: row.created_at,
            supervisor: profile,
          };
        })
        .filter(Boolean);

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    const { data: links, error: linksError } = await clientAdmin
      .from("restaurant_employees")
      .select("restaurant_id, created_at")
      .eq("user_id", payload.supervisor_id)
      .order("created_at", { ascending: false });

    if (linksError) {
      throw { code: 409, message: "No se pudo listar restaurantes de supervisora", category: "BUSINESS", details: linksError };
    }

    const restaurantIds = [...new Set((links ?? []).map((x) => Number(x.restaurant_id)))];
    const { data: restaurants, error: restaurantsError } = restaurantIds.length
      ? await clientAdmin
          .from("restaurants")
          .select("id, name, is_active, city, state")
          .in("id", restaurantIds)
      : { data: [], error: null };

    if (restaurantsError) {
      throw { code: 409, message: "No se pudieron cargar restaurantes", category: "BUSINESS", details: restaurantsError };
    }

    const byRestaurantId = new Map((restaurants ?? []).map((r) => [Number(r.id), r]));
    const items = (links ?? [])
      .map((row) => {
        const restaurant = byRestaurantId.get(Number(row.restaurant_id));
        if (!restaurant) return null;
        return {
          restaurant_id: row.restaurant_id,
          assigned_at: row.created_at,
          restaurant,
        };
      })
      .filter(Boolean);

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
