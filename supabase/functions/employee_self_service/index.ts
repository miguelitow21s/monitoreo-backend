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
import { notifyIncidentCreated, safeDispatchPendingEmailNotifications } from "../_shared/emailNotifications.ts";
import { getSystemSettings, resolveCleaningAreas } from "../_shared/systemSettings.ts";

const endpoint = "employee_self_service";

const myDashboardAction = z.object({
  action: z.literal("my_dashboard"),
  schedule_limit: z.number().int().min(1).max(50).default(10),
  pending_tasks_limit: z.number().int().min(1).max(20).default(10),
});

const myActiveShiftAction = z.object({
  action: z.literal("my_active_shift"),
});

const myHoursHistoryAction = z.object({
  action: z.literal("my_hours_history"),
  period_start: commonSchemas.dateYmd.optional(),
  period_end: commonSchemas.dateYmd.optional(),
  limit: z.number().int().min(1).max(500).default(120),
});

const createObservationAction = z.object({
  action: z.literal("create_observation"),
  shift_id: commonSchemas.shiftId,
  kind: z.enum(["observation", "alert"]).default("observation"),
  message: z.string().trim().min(5).max(5000),
});

const payloadSchema = z.discriminatedUnion("action", [
  myDashboardAction,
  myActiveShiftAction,
  myHoursHistoryAction,
  createObservationAction,
]);

function diffHours(startIso: string | null, endIso: string | null) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms <= 0) return null;
  return Number((ms / 3600000).toFixed(2));
}

function addUtcDays(base: Date, days: number) {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function buildStartWindow(
  scheduledStart: string | null | undefined,
  scheduledEnd: string | null | undefined,
  settings: Awaited<ReturnType<typeof getSystemSettings>>,
  now: Date,
  canStartShift: boolean
) {
  const server_now = now.toISOString();
  if (!scheduledStart || !scheduledEnd) {
    return {
      earliest: null,
      latest: null,
      server_now,
      can_start_now: false,
    };
  }

  const start = new Date(String(scheduledStart));
  const end = new Date(String(scheduledEnd));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return {
      earliest: null,
      latest: null,
      server_now,
      can_start_now: false,
    };
  }

  const earlyToleranceMs = Math.max(0, Number(settings.shifts.early_start_tolerance_minutes ?? 0)) * 60 * 1000;
  const lateToleranceMs = Math.max(0, Number(settings.shifts.late_start_tolerance_minutes ?? 0)) * 60 * 1000;
  const earliest = new Date(start.getTime() - earlyToleranceMs);
  const latest = new Date(end.getTime() + lateToleranceMs);
  const canStartNow = canStartShift && now >= earliest && now <= latest;

  return {
    earliest: earliest.toISOString(),
    latest: latest.toISOString(),
    server_now,
    can_start_now: canStartNow,
  };
}

async function getShiftEvidenceSummary(
  shiftId: number,
  settings: Awaited<ReturnType<typeof getSystemSettings>>
) {
  const required_start_evidence_count = settings.evidence.require_start_photos ? 1 : 0;
  const required_end_evidence_count = settings.evidence.require_end_photos ? 1 : 0;

  const [startCountRes, endCountRes] = await Promise.all([
    clientAdmin
      .from("shift_photos")
      .select("id", { count: "exact", head: true })
      .eq("shift_id", shiftId)
      .eq("type", "inicio"),
    clientAdmin
      .from("shift_photos")
      .select("id", { count: "exact", head: true })
      .eq("shift_id", shiftId)
      .eq("type", "fin"),
  ]);

  if (startCountRes.error) {
    throw { code: 409, message: "No se pudo consultar evidencias de inicio", category: "BUSINESS", details: startCountRes.error };
  }
  if (endCountRes.error) {
    throw { code: 409, message: "No se pudo consultar evidencias de fin", category: "BUSINESS", details: endCountRes.error };
  }

  const start_evidence_count = Number(startCountRes.count ?? 0);
  const end_evidence_count = Number(endCountRes.count ?? 0);

  return {
    has_start_evidence: start_evidence_count > 0,
    start_evidence_count,
    has_end_evidence: end_evidence_count > 0,
    end_evidence_count,
    required_start_evidence_count,
    required_end_evidence_count,
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
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["empleado"]);
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

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 30, window_seconds: 60 });

    if (payload.action === "my_active_shift") {
      const { data: activeShift, error: activeShiftError } = await clientAdmin
        .from("shifts")
        .select("id, restaurant_id, start_time, end_time, state")
        .eq("employee_id", user.id)
        .eq("state", "activo")
        .order("start_time", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (activeShiftError) {
        throw { code: 409, message: "No se pudo consultar turno activo", category: "BUSINESS", details: activeShiftError };
      }

      let activeShiftWithEvidence = activeShift ?? null;
      if (activeShiftWithEvidence) {
        const settings = await getSystemSettings(clientAdmin);
        const evidenceSummary = await getShiftEvidenceSummary(Number(activeShiftWithEvidence.id), settings);
        activeShiftWithEvidence = {
          ...activeShiftWithEvidence,
          ...evidenceSummary,
        };
      }

      const successPayload = { success: true, data: activeShiftWithEvidence, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "my_dashboard") {
      const now = new Date();
      const nowIso = now.toISOString();
      const monthAgoIso = addUtcDays(new Date(), -30).toISOString();
      const settings = await getSystemSettings(clientAdmin);

      const [activeShiftRes, linksRes, scheduleRes, tasksRes, shiftsRes] = await Promise.all([
        clientAdmin
          .from("shifts")
          .select("id, restaurant_id, start_time, state")
          .eq("employee_id", user.id)
          .eq("state", "activo")
          .order("start_time", { ascending: false })
          .limit(1)
          .maybeSingle(),
        clientAdmin
          .from("restaurant_employees")
          .select("restaurant_id, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }),
        clientAdmin
          .from("scheduled_shifts")
          .select("id, restaurant_id, scheduled_start, scheduled_end, status, notes")
          .eq("employee_id", user.id)
          .eq("status", "scheduled")
          .gte("scheduled_end", nowIso)
          .order("scheduled_start", { ascending: true })
          .limit(payload.schedule_limit),
        clientAdmin
          .from("operational_tasks")
          .select("id, title, priority, status, due_at, restaurant_id")
          .eq("assigned_employee_id", user.id)
          .in("status", ["pending", "in_progress"])
          .order("updated_at", { ascending: false })
          .limit(payload.pending_tasks_limit),
        clientAdmin
          .from("shifts")
          .select("id, start_time, end_time")
          .eq("employee_id", user.id)
          .gte("start_time", monthAgoIso)
          .lte("start_time", nowIso),
      ]);

      if (activeShiftRes.error) {
        throw { code: 409, message: "No se pudo consultar turno activo", category: "BUSINESS", details: activeShiftRes.error };
      }
      if (linksRes.error) {
        throw { code: 409, message: "No se pudo consultar restaurantes asignados", category: "BUSINESS", details: linksRes.error };
      }
      if (scheduleRes.error) {
        throw { code: 409, message: "No se pudo consultar agenda", category: "BUSINESS", details: scheduleRes.error };
      }
      if (tasksRes.error) {
        throw { code: 409, message: "No se pudieron consultar tareas pendientes", category: "BUSINESS", details: tasksRes.error };
      }
      if (shiftsRes.error) {
        throw { code: 409, message: "No se pudo consultar resumen de horas", category: "BUSINESS", details: shiftsRes.error };
      }

      const assignedRestaurantIds = [...new Set((linksRes.data ?? []).map((x) => Number(x.restaurant_id)).filter((n) => Number.isFinite(n)))];
      const scheduledRestaurantIds = [...new Set((scheduleRes.data ?? []).map((x) => Number(x.restaurant_id)).filter((n) => Number.isFinite(n)))];
      const restaurantIds = [...new Set([...assignedRestaurantIds, ...scheduledRestaurantIds])];

      const restaurantsRes = restaurantIds.length
        ? await clientAdmin
            .from("restaurants")
            .select("id, name, is_active, city, state, address_line, cleaning_areas")
            .in("id", restaurantIds)
        : { data: [], error: null };

      if (restaurantsRes.error) {
        throw { code: 409, message: "No se pudieron consultar restaurantes", category: "BUSINESS", details: restaurantsRes.error };
      }

      const restaurantsById = new Map(
        (restaurantsRes.data ?? []).map((r) => [
          Number(r.id),
          {
            ...r,
            cleaning_areas: resolveCleaningAreas(settings, r.cleaning_areas),
          },
        ])
      );

      let active_shift = activeShiftRes.data ?? null;
      if (active_shift) {
        const { data: scheduledActive, error: scheduledActiveError } = await clientAdmin
          .from("scheduled_shifts")
          .select("scheduled_start, scheduled_end")
          .eq("started_shift_id", active_shift.id)
          .order("scheduled_start", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (scheduledActiveError) {
          throw { code: 409, message: "No se pudo consultar turno programado activo", category: "BUSINESS", details: scheduledActiveError };
        }

        const restaurant = restaurantsById.get(Number(active_shift.restaurant_id)) ?? null;
        const scheduled_hours = diffHours(String(scheduledActive?.scheduled_start ?? null), String(scheduledActive?.scheduled_end ?? null));
        const evidenceSummary = await getShiftEvidenceSummary(Number(active_shift.id), settings);
        active_shift = {
          ...active_shift,
          restaurant,
          restaurant_name: restaurant?.name ?? null,
          scheduled_start: scheduledActive?.scheduled_start ?? null,
          scheduled_end: scheduledActive?.scheduled_end ?? null,
          scheduled_hours,
          ...evidenceSummary,
        };
      }

      const canStartShift = !active_shift;

      const assigned_restaurants = (linksRes.data ?? []).map((row) => ({
        restaurant_id: row.restaurant_id,
        assigned_at: row.created_at,
        restaurant: restaurantsById.get(Number(row.restaurant_id)) ?? null,
      }));

      const scheduled_shifts = (scheduleRes.data ?? []).map((row) => ({
        id: row.id,
        restaurant_id: row.restaurant_id,
        scheduled_start: row.scheduled_start,
        scheduled_end: row.scheduled_end,
        status: row.status,
        notes: row.notes,
        restaurant: restaurantsById.get(Number(row.restaurant_id)) ?? null,
        start_window: buildStartWindow(row.scheduled_start, row.scheduled_end, settings, now, canStartShift),
      }));

      const workedHoursLast30d = (shiftsRes.data ?? []).reduce((acc, row) => acc + (diffHours(String(row.start_time ?? null), String(row.end_time ?? null)) ?? 0), 0);

      const successData = {
        active_shift,
        can_start_shift: canStartShift,
        assigned_restaurants,
        scheduled_shifts,
        pending_tasks_count: (tasksRes.data ?? []).length,
        pending_tasks_preview: tasksRes.data ?? [],
        worked_hours_last_30d: Number(workedHoursLast30d.toFixed(2)),
      };

      const successPayload = { success: true, data: successData, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "my_hours_history") {
      const today = new Date();
      const fallbackStart = addUtcDays(today, -30).toISOString().slice(0, 10);
      const periodStart = payload.period_start ?? fallbackStart;
      const periodEnd = payload.period_end ?? today.toISOString().slice(0, 10);

      if (periodStart > periodEnd) {
        throw { code: 422, message: "Rango de fechas invalido", category: "VALIDATION" };
      }

      const fromIso = `${periodStart}T00:00:00.000Z`;
      const toIso = `${periodEnd}T23:59:59.999Z`;

      const { data: shifts, error: shiftsError } = await clientAdmin
        .from("shifts")
        .select("id, restaurant_id, start_time, end_time, state")
        .eq("employee_id", user.id)
        .gte("start_time", fromIso)
        .lte("start_time", toIso)
        .order("start_time", { ascending: false })
        .limit(payload.limit);

      if (shiftsError) {
        throw { code: 409, message: "No se pudo consultar historial de turnos", category: "BUSINESS", details: shiftsError };
      }

      const shiftIds = [...new Set((shifts ?? []).map((s) => Number(s.id)).filter((id) => Number.isFinite(id)))];
      const scheduledRes = shiftIds.length
        ? await clientAdmin
            .from("scheduled_shifts")
            .select("started_shift_id, scheduled_start, scheduled_end")
            .in("started_shift_id", shiftIds)
        : { data: [], error: null };

      if (scheduledRes.error) {
        throw { code: 409, message: "No se pudo consultar turnos programados", category: "BUSINESS", details: scheduledRes.error };
      }

      const scheduledByShiftId = new Map<number, { scheduled_start: string | null; scheduled_end: string | null }>();
      for (const row of (scheduledRes.data ?? []) as Array<{ started_shift_id: number | null; scheduled_start: string | null; scheduled_end: string | null }>) {
        if (row.started_shift_id == null) continue;
        const key = Number(row.started_shift_id);
        if (!Number.isFinite(key)) continue;
        if (!scheduledByShiftId.has(key)) {
          scheduledByShiftId.set(key, { scheduled_start: row.scheduled_start ?? null, scheduled_end: row.scheduled_end ?? null });
        }
      }

      const restaurantIds = [...new Set((shifts ?? []).map((s) => Number(s.restaurant_id)).filter((n) => Number.isFinite(n)))];
      const restaurantsRes = restaurantIds.length
        ? await clientAdmin
            .from("restaurants")
            .select("id, name, city, state")
            .in("id", restaurantIds)
        : { data: [], error: null };

      if (restaurantsRes.error) {
        throw { code: 409, message: "No se pudo consultar restaurantes del historial", category: "BUSINESS", details: restaurantsRes.error };
      }

      const restaurantsById = new Map((restaurantsRes.data ?? []).map((r) => [Number(r.id), r]));
      const items = (shifts ?? []).map((row) => {
        const scheduled = scheduledByShiftId.get(Number(row.id));
        const scheduled_hours = diffHours(String(scheduled?.scheduled_start ?? null), String(scheduled?.scheduled_end ?? null));
        const hours_worked = diffHours(String(row.start_time ?? null), String(row.end_time ?? null));
        return {
          shift_id: row.id,
          restaurant_id: row.restaurant_id,
          start_time: row.start_time,
          end_time: row.end_time,
          state: row.state,
          hours_worked,
          scheduled_start: scheduled?.scheduled_start ?? null,
          scheduled_end: scheduled?.scheduled_end ?? null,
          scheduled_hours,
          restaurant: restaurantsById.get(Number(row.restaurant_id)) ?? null,
        };
      });

      const totalHours = items.reduce((acc, row) => acc + (row.hours_worked ?? 0), 0);
      const totalScheduledHours = items.reduce((acc, row) => acc + (row.scheduled_hours ?? 0), 0);

      const successData = {
        period_start: periodStart,
        period_end: periodEnd,
        total_shifts: items.length,
        total_hours_worked: Number(totalHours.toFixed(2)),
        total_scheduled_hours: Number(totalScheduledHours.toFixed(2)),
        items,
      };

      const successPayload = { success: true, data: successData, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    const { data: shift, error: shiftError } = await clientAdmin
      .from("shifts")
      .select("id, employee_id")
      .eq("id", payload.shift_id)
      .eq("employee_id", user.id)
      .single();

    if (shiftError || !shift) {
      throw { code: 404, message: "Turno no encontrado para el empleado", category: "BUSINESS", details: shiftError };
    }

    const description = payload.kind === "alert"
      ? `[ALERTA] ${payload.message}`
      : `[OBSERVACION] ${payload.message}`;

    const { data: incident, error: incidentError } = await clientAdmin
      .from("incidents")
      .insert({
        shift_id: payload.shift_id,
        description,
        created_by: user.id,
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (incidentError || !incident) {
      throw { code: 409, message: "No se pudo registrar observacion/alerta", category: "BUSINESS", details: incidentError };
    }

    await safeWriteAudit({
      user_id: user.id,
      action: payload.kind === "alert" ? "EMPLOYEE_ALERT_CREATE" : "EMPLOYEE_OBSERVATION_CREATE",
      context: { shift_id: payload.shift_id, incident_id: incident.id },
      request_id,
    });

    await notifyIncidentCreated({
      incidentId: incident.id,
      shiftId: payload.shift_id,
      actorUserId: user.id,
    });
    await safeDispatchPendingEmailNotifications({ limit: 25, maxAttempts: 5 });

    const successData = {
      incident_id: incident.id,
      kind: payload.kind,
      shift_id: payload.shift_id,
    };
    const successPayload = { success: true, data: successData, error: null, request_id };
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
