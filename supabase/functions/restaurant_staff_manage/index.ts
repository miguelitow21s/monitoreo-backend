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
import { getSystemSettings, resolveCleaningAreas } from "../_shared/systemSettings.ts";

const endpoint = "restaurant_staff_manage";

type AppRole = "super_admin" | "supervisora" | "empleado";

const assignEmployeeAction = z.object({
  action: z.literal("assign_employee"),
  employee_id: z.string().uuid(),
  restaurant_id: commonSchemas.restaurantId,
});

const unassignEmployeeAction = z.object({
  action: z.literal("unassign_employee"),
  employee_id: z.string().uuid(),
  restaurant_id: commonSchemas.restaurantId,
});

const listByRestaurantAction = z.object({
  action: z.literal("list_by_restaurant"),
  restaurant_id: commonSchemas.restaurantId.optional(),
});

const listByEmployeeAction = z.object({
  action: z.literal("list_by_employee"),
  employee_id: z.string().uuid(),
});

const listMyRestaurantsAction = z.object({
  action: z.literal("list_my_restaurants"),
});

const listAssignableEmployeesAction = z.object({
  action: z.literal("list_assignable_employees"),
  restaurant_id: commonSchemas.restaurantId.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

const payloadSchema = z.discriminatedUnion("action", [
  assignEmployeeAction,
  unassignEmployeeAction,
  listByRestaurantAction,
  listByEmployeeAction,
  listMyRestaurantsAction,
  listAssignableEmployeesAction,
]);

async function ensureEmployeeUser(employeeId: string) {
  const { data, error } = await clientAdmin
    .from("profiles")
    .select("id, role, is_active, email, first_name, last_name, full_name")
    .eq("id", employeeId)
    .single();

  if (error || !data) {
    throw { code: 404, message: "Empleado no encontrado", category: "BUSINESS", details: error };
  }

  if (String(data.role) !== "empleado") {
    throw { code: 422, message: "El usuario no tiene rol empleado", category: "VALIDATION" };
  }

  if (data.is_active === false) {
    throw { code: 422, message: "No se puede asignar un empleado inactivo", category: "VALIDATION" };
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

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 50, window_seconds: 60 });

    if (payload.action === "assign_employee") {
      roleGuard(user, ["super_admin", "supervisora"]);
      await ensureEmployeeUser(payload.employee_id);
      const writeClient = user.role === "supervisora" ? clientAdmin : clientUser;
      const { error } = await writeClient
        .from("restaurant_employees")
        .upsert(
          {
            restaurant_id: payload.restaurant_id,
            user_id: payload.employee_id,
          },
          { onConflict: "restaurant_id,user_id" }
        );

      if (error) {
        throw { code: 409, message: "No se pudo asignar empleado", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "STAFF_ASSIGN_EMPLOYEE",
        context: {
          employee_id: payload.employee_id,
          restaurant_id: payload.restaurant_id,
          actor_role: user.role,
        },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          assignment: {
            employee_id: payload.employee_id,
            restaurant_id: payload.restaurant_id,
          },
        },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "unassign_employee") {
      roleGuard(user, ["super_admin", "supervisora"]);
      const writeClient = user.role === "supervisora" ? clientAdmin : clientUser;
      const { error } = await writeClient
        .from("restaurant_employees")
        .delete()
        .eq("restaurant_id", payload.restaurant_id)
        .eq("user_id", payload.employee_id);

      if (error) {
        throw { code: 409, message: "No se pudo desasignar empleado", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "STAFF_UNASSIGN_EMPLOYEE",
        context: {
          employee_id: payload.employee_id,
          restaurant_id: payload.restaurant_id,
          actor_role: user.role,
        },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          assignment: {
            employee_id: payload.employee_id,
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
      roleGuard(user, ["super_admin", "supervisora"]);
      const restaurantId = payload.restaurant_id ?? null;
      if (!restaurantId) {
        throw { code: 422, message: "restaurant_id requerido", category: "VALIDATION" };
      }

      const { data: links, error: linksError } = await clientAdmin
        .from("restaurant_employees")
        .select("user_id, created_at")
        .eq("restaurant_id", restaurantId)
        .order("created_at", { ascending: false });

      if (linksError) {
        throw { code: 409, message: "No se pudo listar personal del restaurante", category: "BUSINESS", details: linksError };
      }

      const employeeIds = [...new Set((links ?? []).map((x) => String(x.user_id)))];
      const { data: profiles, error: profilesError } = employeeIds.length
        ? await clientAdmin
            .from("profiles")
            .select("id, first_name, last_name, full_name, email, role, is_active")
            .in("id", employeeIds)
            .eq("role", "empleado")
        : { data: [], error: null };

      if (profilesError) {
        throw { code: 409, message: "No se pudieron cargar empleados", category: "BUSINESS", details: profilesError };
      }

      const byId = new Map((profiles ?? []).map((p) => [String(p.id), p]));
      const items = (links ?? [])
        .map((row) => {
          const profile = byId.get(String(row.user_id));
          if (!profile) return null;
          return {
            employee_id: row.user_id,
            assigned_at: row.created_at,
            employee: profile,
          };
        })
        .filter(Boolean);

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_my_restaurants") {
      roleGuard(user, ["empleado", "supervisora"]);

      const settings = await getSystemSettings(clientAdmin);

      if (user.role === "supervisora") {
        const { data: restaurants, error: restaurantsError } = await clientAdmin
          .from("restaurants")
          .select("id, name, address_line, lat, lng, geofence_radius_m, is_active, cleaning_areas")
          .eq("is_active", true)
          .order("name", { ascending: true });

        if (restaurantsError) {
          throw { code: 409, message: "No se pudieron cargar restaurantes", category: "BUSINESS", details: restaurantsError };
        }

        const items = (restaurants ?? []).map((row) => ({
          ...row,
          cleaning_areas: resolveCleaningAreas(settings, row.cleaning_areas),
        }));

        const successPayload = { success: true, data: { items }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
        return response(true, successPayload.data, null, request_id);
      }

      const { data: links, error: linksError } = await clientAdmin
        .from("restaurant_employees")
        .select("restaurant_id, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (linksError) {
        throw { code: 409, message: "No se pudieron listar restaurantes asignados", category: "BUSINESS", details: linksError };
      }

      const restaurantIds = [...new Set((links ?? []).map((row) => Number(row.restaurant_id)).filter((n) => Number.isFinite(n)))];
      if (restaurantIds.length === 0) {
        const emptyPayload = { success: true, data: { items: [] }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: emptyPayload });
        return response(true, emptyPayload.data, null, request_id);
      }

      const { data: restaurants, error: restaurantsError } = await clientAdmin
        .from("restaurants")
        .select("id, name, address_line, lat, lng, geofence_radius_m, is_active, cleaning_areas")
        .in("id", restaurantIds)
        .order("name", { ascending: true });

      if (restaurantsError) {
        throw { code: 409, message: "No se pudieron cargar restaurantes", category: "BUSINESS", details: restaurantsError };
      }

      const items = (restaurants ?? []).map((row) => ({
        ...row,
        cleaning_areas: resolveCleaningAreas(settings, row.cleaning_areas),
      }));

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_assignable_employees") {
      roleGuard(user, ["supervisora", "super_admin"]);

      let restaurantIds: number[] | null = null;
      if (payload.restaurant_id) {
        restaurantIds = [payload.restaurant_id];
      }

      let query = clientAdmin
        .from("profiles")
        .select("id, full_name, first_name, last_name, phone_number, email, role, is_active")
        .eq("role", "empleado")
        .order("full_name", { ascending: true })
        .limit(payload.limit);

      const { data: profiles, error: profilesError } = await query;
      if (profilesError) {
        throw { code: 409, message: "No se pudieron cargar empleados", category: "BUSINESS", details: profilesError };
      }

      const employeeIds = [...new Set((profiles ?? []).map((row) => String(row.id)).filter((v) => !!v))];
      const { data: assignments, error: assignmentsError } = employeeIds.length
        ? await clientAdmin
            .from("restaurant_employees")
            .select("user_id, restaurant_id")
            .in("user_id", employeeIds)
        : { data: [], error: null };

      if (assignmentsError) {
        throw { code: 409, message: "No se pudieron cargar asignaciones de empleados", category: "BUSINESS", details: assignmentsError };
      }

      const assignmentCount = new Map<string, number>();
      const assignedToTarget = new Set<string>();
      for (const row of assignments ?? []) {
        const key = String(row.user_id);
        assignmentCount.set(key, (assignmentCount.get(key) ?? 0) + 1);
        if (payload.restaurant_id && Number(row.restaurant_id) === payload.restaurant_id) {
          assignedToTarget.add(key);
        }
      }

      const items = (profiles ?? []).map((row) => {
        const fullName =
          row.full_name ??
          [row.first_name, row.last_name].filter((v) => !!v).join(" ").trim() ??
          null;
        const count = assignmentCount.get(String(row.id)) ?? 0;
        return {
          id: row.id,
          full_name: fullName,
          phone_number: row.phone_number ?? null,
          email: row.email ?? null,
          role: row.role,
          is_active: row.is_active,
          assigned_restaurants_count: count,
          assigned_to_restaurant: payload.restaurant_id ? assignedToTarget.has(String(row.id)) : undefined,
        };
      });

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_by_employee") {
      roleGuard(user, ["super_admin", "supervisora"]);

      const { data: links, error: linksError } = await clientAdmin
        .from("restaurant_employees")
        .select("restaurant_id, created_at")
        .eq("user_id", payload.employee_id)
        .order("created_at", { ascending: false });

      if (linksError) {
        throw { code: 409, message: "No se pudo listar restaurantes del empleado", category: "BUSINESS", details: linksError };
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
    }
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
