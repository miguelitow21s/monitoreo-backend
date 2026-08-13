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
import { runInBackground } from "../_shared/background.ts";
import { autoCloseOverdueShifts, expireOverdueScheduledShifts } from "../_shared/shiftAutoClose.ts";
import { getSystemSettings, resolveCleaningAreas } from "../_shared/systemSettings.ts";
import { endOfLocalDay, formatAtSite, safeTimezone } from "../_shared/timezone.ts";

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

  // Business rule: the contractor may start whenever they want; the only limit is
  // the end of the service window. `earliest` is kept for display only.
  const earliest = start;
  const latest = end;
  const canStartNow = canStartShift && now <= latest;

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
        throw { code: 409, message: "No se pudo consultar servicio activo", category: "BUSINESS", details: activeShiftError };
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

      // Close any service whose scheduled window already ended, before reading
      // state, so the dashboard never shows a stale "active" shift (#1), and mark
      // the ones that were never started as expired so they stop being invisible.
      await autoCloseOverdueShifts({ employeeId: user.id });
      await expireOverdueScheduledShifts({ employeeId: user.id });

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
          .select("id, title, priority, status, due_at, restaurant_id, task_scope, requires_evidence, evidence_type")
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
        throw { code: 409, message: "No se pudo consultar sitios asignados", category: "BUSINESS", details: linksRes.error };
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

      const [restaurantsRes, restaurantTasksRes, visitableRes] = await Promise.all([
        restaurantIds.length
          ? clientAdmin
              .from("restaurants")
              .select("id, name, is_active, city, state, address_line, timezone, lat, lng, radius, geofence_radius_m, cleaning_areas")
              .in("id", restaurantIds)
          : Promise.resolve({ data: [], error: null }),
        assignedRestaurantIds.length > 0
          ? clientAdmin
              .from("operational_tasks")
              .select("id, title, priority, status, due_at, restaurant_id, task_scope, requires_evidence, evidence_type")
              .eq("task_scope", "restaurant")
              .in("restaurant_id", assignedRestaurantIds)
              .in("status", ["pending", "in_progress"])
              .order("updated_at", { ascending: false })
              .limit(payload.pending_tasks_limit)
          : Promise.resolve({ data: [], error: null }),
        // Ad-hoc visit model: the contractor may start a visit at ANY active site,
        // so the app needs every active restaurant (with geo) to GPS-match against.
        clientAdmin
          .from("restaurants")
          .select("id, name, city, state, address_line, timezone, lat, lng, radius, geofence_radius_m")
          .eq("is_active", true)
          .order("name", { ascending: true }),
      ]);

      if (restaurantsRes.error) {
        throw { code: 409, message: "No se pudieron consultar sitios", category: "BUSINESS", details: restaurantsRes.error };
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
          throw { code: 409, message: "No se pudo consultar servicio asignado activo", category: "BUSINESS", details: scheduledActiveError };
        }

        const restaurant = restaurantsById.get(Number(active_shift.restaurant_id)) ?? null;
        const scheduled_hours = diffHours(String(scheduledActive?.scheduled_start ?? null), String(scheduledActive?.scheduled_end ?? null));
        const evidenceSummary = await getShiftEvidenceSummary(Number(active_shift.id), settings);
        active_shift = {
          ...active_shift,
          restaurant,
          restaurant_name: restaurant?.name ?? null,
          restaurant_timezone: (restaurant as { timezone?: string | null } | null)?.timezone ?? null,
          scheduled_start: scheduledActive?.scheduled_start ?? null,
          scheduled_end: scheduledActive?.scheduled_end ?? null,
          scheduled_hours,
          ...evidenceSummary,
        };
      }

      const canStartShift = !active_shift;

      // assigned_restaurants[] was removed with the visit migration -- the app uses
      // visitable_restaurants[] now, and site access no longer depends on assignment.

      const scheduled_shifts = (scheduleRes.data ?? []).map((row) => {
        const restaurantTz = safeTimezone(
          (restaurantsById.get(Number(row.restaurant_id)) as { timezone?: string | null } | undefined)?.timezone
        );
        return {
          id: row.id,
          restaurant_id: row.restaurant_id,
          scheduled_start: row.scheduled_start,
          scheduled_end: row.scheduled_end,
          status: row.status,
          notes: row.notes,
          restaurant: restaurantsById.get(Number(row.restaurant_id)) ?? null,
          restaurant_timezone:
            (restaurantsById.get(Number(row.restaurant_id)) as { timezone?: string | null } | undefined)?.timezone ?? null,
          start_window: buildStartWindow(row.scheduled_start, row.scheduled_end, settings, now, canStartShift),
          // Preformatted in the site's own clock so no client does tz math.
          local: {
            timezone: restaurantTz,
            start: formatAtSite(row.scheduled_start, restaurantTz),
            end: formatAtSite(row.scheduled_end, restaurantTz),
          },
        };
      });

      // All of today's startable/active services in one array, each with the
      // geofence data the app needs to pick the right one by GPS when several
      // overlap in time at different sites (#1).
      const toGeoRestaurant = (restaurant: Record<string, unknown> | null | undefined) => {
        if (!restaurant) return null;
        const radius = Number(restaurant.geofence_radius_m ?? restaurant.radius ?? 0);
        return {
          id: restaurant.id ?? null,
          name: restaurant.name ?? null,
          city: restaurant.city ?? null,
          state: restaurant.state ?? null,
          address_line: restaurant.address_line ?? null,
          timezone: restaurant.timezone ?? null,
          lat: restaurant.lat ?? null,
          lng: restaurant.lng ?? null,
          radius_meters: Number.isFinite(radius) && radius > 0 ? radius : null,
        };
      };

      // "In play today" at the SITE's clock, not the contractor's and not UTC.
      //
      // A service qualifies when it hasn't ended yet (the query already filters
      // `scheduled_end >= now`) and it starts before the site's local midnight
      // rolls over. That keeps an overnight service (Sat 20:00 -> Sun 05:00 PDT)
      // visible on both calendar days until it actually ends, and drops
      // tomorrow's services so the app never GPS-matches against a shift that
      // isn't in play. The full agenda still travels in `scheduled_shifts`.
      const isInPlayToday = (row: { restaurant_id: unknown; scheduled_start: string | null }) => {
        if (!row.scheduled_start) return false;
        const restaurant = restaurantsById.get(Number(row.restaurant_id)) as { timezone?: string | null } | undefined;
        const tz = safeTimezone(restaurant?.timezone);
        const start = new Date(String(row.scheduled_start));
        if (Number.isNaN(start.getTime())) return false;
        return start < endOfLocalDay(now, tz);
      };

      const siteTimezoneOf = (restaurantId: unknown) =>
        safeTimezone((restaurantsById.get(Number(restaurantId)) as { timezone?: string | null } | undefined)?.timezone);

      const today_shifts = [
        ...(active_shift
          ? [
              {
                shift_id: active_shift.id,
                scheduled_shift_id: null,
                restaurant_id: active_shift.restaurant_id,
                scheduled_start: active_shift.scheduled_start ?? null,
                scheduled_end: active_shift.scheduled_end ?? null,
                state: "activo",
                started_at: active_shift.start_time ?? null,
                restaurant: toGeoRestaurant(restaurantsById.get(Number(active_shift.restaurant_id)) as Record<string, unknown> | undefined),
                start_window: null,
                local: {
                  timezone: siteTimezoneOf(active_shift.restaurant_id),
                  start: formatAtSite(active_shift.scheduled_start ?? null, siteTimezoneOf(active_shift.restaurant_id)),
                  end: formatAtSite(active_shift.scheduled_end ?? null, siteTimezoneOf(active_shift.restaurant_id)),
                },
              },
            ]
          : []),
        ...scheduled_shifts.filter(isInPlayToday).map((row) => ({
          shift_id: null,
          scheduled_shift_id: row.id,
          restaurant_id: row.restaurant_id,
          scheduled_start: row.scheduled_start,
          scheduled_end: row.scheduled_end,
          state: row.status,
          started_at: null,
          restaurant: toGeoRestaurant(restaurantsById.get(Number(row.restaurant_id)) as Record<string, unknown> | undefined),
          start_window: row.start_window,
          local: {
            timezone: siteTimezoneOf(row.restaurant_id),
            start: formatAtSite(row.scheduled_start, siteTimezoneOf(row.restaurant_id)),
            end: formatAtSite(row.scheduled_end, siteTimezoneOf(row.restaurant_id)),
          },
        })),
      ];

      const workedHoursLast30d = (shiftsRes.data ?? []).reduce((acc, row) => acc + (diffHours(String(row.start_time ?? null), String(row.end_time ?? null)) ?? 0), 0);

      // Merge assigned tasks + restaurant-scoped tasks, deduplicate by id, limit to pending_tasks_limit
      const assignedTaskIds = new Set((tasksRes.data ?? []).map((t) => t.id));
      const restaurantOnlyTasks = (restaurantTasksRes.data ?? []).filter((t) => !assignedTaskIds.has(t.id));
      const allPendingTasks = [...(tasksRes.data ?? []), ...restaurantOnlyTasks].slice(0, payload.pending_tasks_limit);

      // Every active site the contractor can walk into and start a visit, with the
      // geofence data the app needs to pick the nearest one by GPS.
      const visitable_restaurants = (visitableRes.data ?? []).map((r) => ({
        ...(toGeoRestaurant(r as Record<string, unknown>) ?? {}),
        address_line: (r as { address_line?: string | null }).address_line ?? null,
      }));

      const successData = {
        active_shift,
        can_start_shift: canStartShift,
        visitable_restaurants,
        scheduled_shifts,
        today_shifts,
        pending_tasks_count: allPendingTasks.length,
        pending_tasks_preview: allPendingTasks,
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

      // Query a UTC window widened by +/-1 day so we don't miss shifts that fall
      // inside the requested LOCAL-date range but outside the UTC window; each
      // shift is then attributed to the calendar day of ITS restaurant's
      // timezone (audit M3). Hour totals are unchanged — only the day changes.
      const windowFrom = addUtcDays(new Date(`${periodStart}T00:00:00.000Z`), -1).toISOString();
      const windowTo = addUtcDays(new Date(`${periodEnd}T23:59:59.999Z`), 1).toISOString();

      const localDateInTz = (iso: string | null | undefined, tz: string): string | null => {
        if (!iso) return null;
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return null;
        try {
          return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
        } catch {
          return d.toISOString().slice(0, 10);
        }
      };

      const { data: shifts, error: shiftsError } = await clientAdmin
        .from("shifts")
        .select("id, restaurant_id, start_time, end_time, state")
        .eq("employee_id", user.id)
        .gte("start_time", windowFrom)
        .lte("start_time", windowTo)
        .order("start_time", { ascending: false })
        .limit(payload.limit);

      if (shiftsError) {
        throw { code: 409, message: "No se pudo consultar historial de servicios", category: "BUSINESS", details: shiftsError };
      }

      const shiftIds = [...new Set((shifts ?? []).map((s) => Number(s.id)).filter((id) => Number.isFinite(id)))];
      const scheduledRes = shiftIds.length
        ? await clientAdmin
            .from("scheduled_shifts")
            .select("started_shift_id, scheduled_start, scheduled_end")
            .in("started_shift_id", shiftIds)
        : { data: [], error: null };

      if (scheduledRes.error) {
        throw { code: 409, message: "No se pudo consultar servicios asignados", category: "BUSINESS", details: scheduledRes.error };
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
            .select("id, name, city, state, timezone")
            .in("id", restaurantIds)
        : { data: [], error: null };

      if (restaurantsRes.error) {
        throw { code: 409, message: "No se pudo consultar sitios del historial", category: "BUSINESS", details: restaurantsRes.error };
      }

      const restaurantsById = new Map((restaurantsRes.data ?? []).map((r) => [Number(r.id), r]));
      const allItems = (shifts ?? []).map((row) => {
        const restaurant = restaurantsById.get(Number(row.restaurant_id)) ?? null;
        const tz = (restaurant as { timezone?: string | null } | null)?.timezone || "America/Los_Angeles";
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
          restaurant,
          restaurant_timezone: tz,
          // Calendar day in the restaurant's local time — use this to bucket by day.
          local_date: localDateInTz(row.start_time, tz),
        };
      });

      // Keep only shifts whose local (restaurant-timezone) day is in the range.
      const items = allItems.filter(
        (it) => it.local_date != null && it.local_date >= periodStart && it.local_date <= periodEnd
      );

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
      throw { code: 404, message: "Servicio no encontrado", category: "BUSINESS", details: shiftError };
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
    runInBackground(safeDispatchPendingEmailNotifications({ limit: 25, maxAttempts: 5 }));

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
