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
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "admin_dashboard_metrics";

type AppRole = "super_admin" | "supervisora" | "empleado";

const payloadSchema = z.object({
  action: z.literal("summary"),
  restaurant_id: commonSchemas.restaurantId.optional(),
  period_start: commonSchemas.dateYmd.optional(),
  period_end: commonSchemas.dateYmd.optional(),
});

type ShiftRow = {
  id: number;
  restaurant_id: number | null;
  start_time: string | null;
  end_time: string | null;
  state: string | null;
};

type ScheduledRow = {
  id: number;
  restaurant_id: number | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
};

type TaskRow = {
  id: number;
  restaurant_id: number | null;
  status: string | null;
  updated_at: string | null;
};

type DeliveryRow = {
  id: number;
  restaurant_id: number | null;
  quantity: number | null;
  delivered_at: string | null;
  supply_id: number | null;
};

type SupplyRow = {
  id: number;
  unit_cost: number | null;
};

function diffHours(startIso: string | null, endIso: string | null) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Number((ms / 3600000).toFixed(2));
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
    const { user } = await authGuard(req);
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

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 20, window_seconds: 60 });

    const today = new Date();
    const fallbackStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const periodStart = payload.period_start ?? fallbackStart.toISOString().slice(0, 10);
    const periodEnd = payload.period_end ?? today.toISOString().slice(0, 10);

    if (periodStart > periodEnd) {
      throw { code: 422, message: "Rango de fechas invalido", category: "VALIDATION" };
    }

    const fromIso = `${periodStart}T00:00:00.000Z`;
    const toIso = `${periodEnd}T23:59:59.999Z`;

    const [{ data: users, error: usersError }, { data: restaurants, error: restaurantsError }] = await Promise.all([
      clientAdmin.from("profiles").select("id, role, is_active"),
      clientAdmin.from("restaurants").select("id, name, is_active"),
    ]);

    if (usersError) {
      throw { code: 409, message: "No se pudieron cargar usuarios", category: "BUSINESS", details: usersError };
    }
    if (restaurantsError) {
      throw { code: 409, message: "No se pudieron cargar restaurantes", category: "BUSINESS", details: restaurantsError };
    }

    let shiftsQuery = clientAdmin
      .from("shifts")
      .select("id, restaurant_id, start_time, end_time, state")
      .gte("start_time", fromIso)
      .lte("start_time", toIso);
    if (payload.restaurant_id) shiftsQuery = shiftsQuery.eq("restaurant_id", payload.restaurant_id);
    const { data: shiftsRaw, error: shiftsError } = await shiftsQuery;

    if (shiftsError) {
      throw { code: 409, message: "No se pudieron cargar turnos", category: "BUSINESS", details: shiftsError };
    }

    let scheduledQuery = clientAdmin
      .from("scheduled_shifts")
      .select("id, restaurant_id, scheduled_start, scheduled_end")
      .gte("scheduled_start", fromIso)
      .lte("scheduled_start", toIso);
    if (payload.restaurant_id) scheduledQuery = scheduledQuery.eq("restaurant_id", payload.restaurant_id);
    const { data: scheduledRaw, error: scheduledError } = await scheduledQuery;

    if (scheduledError) {
      throw { code: 409, message: "No se pudieron cargar turnos programados", category: "BUSINESS", details: scheduledError };
    }

    let tasksQuery = clientAdmin
      .from("operational_tasks")
      .select("id, restaurant_id, status, updated_at")
      .gte("updated_at", fromIso)
      .lte("updated_at", toIso);
    if (payload.restaurant_id) tasksQuery = tasksQuery.eq("restaurant_id", payload.restaurant_id);
    const { data: tasksRaw, error: tasksError } = await tasksQuery;

    if (tasksError) {
      throw { code: 409, message: "No se pudieron cargar tareas operativas", category: "BUSINESS", details: tasksError };
    }

    let deliveriesQuery = clientAdmin
      .from("supply_deliveries")
      .select("id, restaurant_id, quantity, delivered_at, supply_id")
      .gte("delivered_at", fromIso)
      .lte("delivered_at", toIso);
    if (payload.restaurant_id) deliveriesQuery = deliveriesQuery.eq("restaurant_id", payload.restaurant_id);
    const { data: deliveriesRaw, error: deliveriesError } = await deliveriesQuery;

    if (deliveriesError) {
      throw { code: 409, message: "No se pudieron cargar entregas de insumos", category: "BUSINESS", details: deliveriesError };
    }

    let incidentsQuery = clientAdmin.from("incidents").select("id, shift_id, created_at").gte("created_at", fromIso).lte("created_at", toIso);
    const { data: incidentsRaw, error: incidentsError } = await incidentsQuery;

    if (incidentsError) {
      throw { code: 409, message: "No se pudieron cargar incidentes", category: "BUSINESS", details: incidentsError };
    }

    const { data: suppliesRaw, error: suppliesError } = await clientAdmin.from("supplies").select("id, unit_cost");
    if (suppliesError) {
      throw { code: 409, message: "No se pudieron cargar costos de insumos", category: "BUSINESS", details: suppliesError };
    }

    const shifts = (shiftsRaw ?? []) as ShiftRow[];
    const scheduledShifts = (scheduledRaw ?? []) as ScheduledRow[];
    const tasks = (tasksRaw ?? []) as TaskRow[];
    const deliveries = (deliveriesRaw ?? []) as DeliveryRow[];
    const incidents = incidentsRaw ?? [];
    const supplies = (suppliesRaw ?? []) as SupplyRow[];

    const shiftsInRange = shifts;
    const tasksInRange = tasks;
    const deliveriesInRange = deliveries;
    const incidentsInRange = incidents;

    const supplyUnitCost = new Map<number, number>();
    for (const s of supplies) {
      supplyUnitCost.set(Number(s.id), Number(s.unit_cost ?? 0));
    }

    let hoursWorked = 0;
    for (const s of shiftsInRange) {
      if (s.start_time && s.end_time) {
        const delta = new Date(s.end_time).getTime() - new Date(s.start_time).getTime();
        if (delta > 0) {
          hoursWorked += delta / 3600000;
        }
      }
    }

    let scheduledHoursTotal = 0;
    for (const s of scheduledShifts) {
      const hours = diffHours(s.scheduled_start ?? null, s.scheduled_end ?? null);
      if (hours != null) scheduledHoursTotal += hours;
    }

    let totalSuppliesUnits = 0;
    let totalSuppliesCost = 0;
    for (const d of deliveriesInRange) {
      const qty = Number(d.quantity ?? 0);
      totalSuppliesUnits += qty;
      const unitCost = supplyUnitCost.get(Number(d.supply_id ?? 0)) ?? 0;
      totalSuppliesCost += qty * unitCost;
    }

    const shiftsByRestaurant = new Map<number, number>();
    for (const s of shiftsInRange) {
      if (s.restaurant_id == null) continue;
      const key = Number(s.restaurant_id);
      shiftsByRestaurant.set(key, (shiftsByRestaurant.get(key) ?? 0) + 1);
    }

    const restaurantsById = new Map((restaurants ?? []).map((r) => [Number(r.id), r]));
    const topRestaurants = [...shiftsByRestaurant.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([restaurantId, shiftCount]) => ({
        restaurant_id: restaurantId,
        restaurant_name: restaurantsById.get(restaurantId)?.name ?? null,
        shifts: shiftCount,
      }));

    const usersList = users ?? [];
    const restaurantsList = restaurants ?? [];

    const employees = usersList.filter((u) => String(u.role) === "empleado");
    const supervisors = usersList.filter((u) => String(u.role) === "supervisora");

    const summary = {
      period_start: periodStart,
      period_end: periodEnd,
      restaurant_id: payload.restaurant_id ?? null,
      users: {
        total: usersList.length,
        active: usersList.filter((u) => u.is_active !== false).length,
        inactive: usersList.filter((u) => u.is_active === false).length,
        employees_total: employees.length,
        supervisors_total: supervisors.length,
      },
      restaurants: {
        total: restaurantsList.length,
        active: restaurantsList.filter((r) => r.is_active !== false).length,
        inactive: restaurantsList.filter((r) => r.is_active === false).length,
      },
      shifts: {
        total: shiftsInRange.length,
        scheduled_total: scheduledShifts.length,
        active: shiftsInRange.filter((s) => String(s.state) === "activo").length,
        approved: shiftsInRange.filter((s) => String(s.state) === "aprobado").length,
        rejected: shiftsInRange.filter((s) => String(s.state) === "rechazado").length,
        finished: shiftsInRange.filter((s) => String(s.state) === "finalizado").length,
      },
      productivity: {
        hours_worked_total: Number(hoursWorked.toFixed(2)),
        average_hours_per_shift: shiftsInRange.length > 0 ? Number((hoursWorked / shiftsInRange.length).toFixed(2)) : 0,
        scheduled_hours_total: Number(scheduledHoursTotal.toFixed(2)),
        average_scheduled_hours_per_shift: scheduledShifts.length > 0 ? Number((scheduledHoursTotal / scheduledShifts.length).toFixed(2)) : 0,
        operational_tasks_completed: tasksInRange.filter((t) => String(t.status) === "completed").length,
        operational_tasks_pending: tasksInRange.filter((t) => String(t.status) === "pending" || String(t.status) === "in_progress").length,
      },
      supplies: {
        deliveries_count: deliveriesInRange.length,
        units_delivered_total: totalSuppliesUnits,
        cost_total: Number(totalSuppliesCost.toFixed(2)),
      },
      incidents: {
        total: incidentsInRange.length,
      },
      top_restaurants_by_shifts: topRestaurants,
    };

    const successPayload = { success: true, data: summary, error: null, request_id };
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
