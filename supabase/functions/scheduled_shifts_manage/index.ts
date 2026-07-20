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
import { getSystemSettings } from "../_shared/systemSettings.ts";
import { parseWallClock, wallClockToUtc, formatAtSite, safeTimezone } from "../_shared/timezone.ts";

const endpoint = "scheduled_shifts_manage";

// Wall-clock scheduling.
//
// A service happens at a site, so the hour someone types when scheduling IS the
// hour at that site. Whoever schedules it may sit in another country; their clock
// is an accident of geography. Clients used to compute the absolute instant
// themselves, which meant every screen was a fresh chance to apply the browser's
// timezone instead of the restaurant's — and some of them did exactly that.
//
// Sending date + times lets the backend do the conversion from
// `restaurants.timezone`, so a client that never computes an instant can never
// compute a wrong one. The instant form stays accepted for compatibility.
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha invalida (use YYYY-MM-DD)");
const timeOfDay = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Hora invalida (use HH:MM)");

const serviceWindowShape = {
  // Preferred: wall clock at the site.
  scheduled_date: calendarDate.optional(),
  start_time: timeOfDay.optional(),
  end_time: timeOfDay.optional(),
  // Legacy: an absolute instant the client computed.
  scheduled_start: z.string().datetime().optional(),
  scheduled_end: z.string().datetime().optional(),
};

// Kept as plain objects: z.discriminatedUnion only accepts ZodObject members, so
// the "exactly one window form" rule is enforced in resolveServiceWindow instead.
const assignAction = z.object({
  action: z.literal("assign"),
  employee_id: z.string().uuid(),
  restaurant_id: commonSchemas.restaurantId,
  notes: z.string().trim().max(1000).optional().nullable(),
  ...serviceWindowShape,
});

const bulkAssignAction = z.object({
  action: z.literal("bulk_assign"),
  entries: z
    .array(
      z.object({
        employee_id: z.string().uuid(),
        restaurant_id: commonSchemas.restaurantId,
        notes: z.string().trim().max(1000).optional().nullable(),
        ...serviceWindowShape,
      })
    )
    .min(1)
    .max(200),
});

const rescheduleAction = z.object({
  action: z.literal("reschedule"),
  scheduled_shift_id: z.number().int().positive(),
  notes: z.string().trim().max(1000).optional().nullable(),
  ...serviceWindowShape,
});

const cancelAction = z.object({
  action: z.literal("cancel"),
  scheduled_shift_id: z.number().int().positive(),
  reason: z.string().trim().max(1000).optional().nullable(),
});

const listAction = z.object({
  action: z.literal("list"),
  employee_id: z.string().uuid().optional(),
  restaurant_id: commonSchemas.restaurantId.optional(),
  status: z.enum(["scheduled", "started", "completed", "cancelled", "expired"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const payloadSchema = z.discriminatedUnion("action", [assignAction, bulkAssignAction, rescheduleAction, cancelAction, listAction]);

type ServiceWindowInput = {
  scheduled_date?: string;
  start_time?: string;
  end_time?: string;
  scheduled_start?: string;
  scheduled_end?: string;
};

/** IANA zone per restaurant id, so a whole bulk payload costs one round-trip. */
async function loadTimezonesByRestaurantId(restaurantIds: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(restaurantIds.filter((id) => Number.isFinite(id)))];
  if (unique.length === 0) return new Map();

  const { data, error } = await clientAdmin.from("restaurants").select("id, timezone").in("id", unique);
  if (error) {
    throw {
      code: 409,
      error_code: "SCHEDULE_TIMEZONE_LOOKUP_FAILED",
      message: "No se pudo resolver la zona horaria del sitio",
      category: "BUSINESS",
      details: error,
    };
  }

  return new Map((data ?? []).map((row) => [Number(row.id), safeTimezone(row.timezone)]));
}

/**
 * Turns either window form into the absolute instants we store.
 *
 * Wall-clock input is read in the SITE's zone. An end time at or before the start
 * means the service runs past midnight (20:00 -> 05:00), so the end belongs to the
 * next local day — resolved in local time, not by adding 24h, so it stays correct
 * across a DST change.
 */
function resolveServiceWindow(
  input: ServiceWindowInput,
  timezone: string
): { scheduled_start: string; scheduled_end: string; timezone: string } {
  const wallClock = Boolean(input.scheduled_date && input.start_time && input.end_time);
  const instants = Boolean(input.scheduled_start && input.scheduled_end);

  if (wallClock === instants) {
    throw {
      code: 422,
      error_code: "SCHEDULE_WINDOW_FORM_INVALID",
      message:
        "Envie scheduled_date + start_time + end_time (hora local del sitio) o scheduled_start + scheduled_end (instantes ISO), pero no ambos",
      category: "VALIDATION",
    };
  }

  if (instants) {
    return {
      scheduled_start: String(input.scheduled_start),
      scheduled_end: String(input.scheduled_end),
      timezone,
    };
  }

  const start = parseWallClock(input.scheduled_date, input.start_time, timezone);
  let end = parseWallClock(input.scheduled_date, input.end_time, timezone);
  if (!start || !end) {
    throw {
      code: 422,
      error_code: "SCHEDULE_WALL_CLOCK_INVALID",
      message: "Fecha u hora local invalida",
      category: "VALIDATION",
    };
  }

  if (end <= start) {
    const [year, month, day] = String(input.scheduled_date).split("-").map(Number);
    const [hour, minute] = String(input.end_time).split(":").map(Number);
    end = wallClockToUtc(year, month, day + 1, hour, minute, timezone);
  }

  return {
    scheduled_start: start.toISOString(),
    scheduled_end: end.toISOString(),
    timezone,
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
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["supervisora", "super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    idempotencyKey = requireIdempotencyKey(req);

    const settings = await getSystemSettings(clientAdmin);
    const minHours = Math.max(0, settings.shifts.min_hours ?? 0);
    const maxHours = Math.max(minHours, settings.shifts.max_hours ?? minHours);

    const assertDurationWindow = (startIso: string, endIso: string) => {
      const start = new Date(startIso);
      const end = new Date(endIso);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw { code: 422, error_code: "SCHEDULE_TIME_RANGE_INVALID", message: "Rango horario invalido", category: "VALIDATION" };
      }
      const hours = (end.getTime() - start.getTime()) / 3600000;
      if (hours < minHours || hours > maxHours) {
        throw {
          code: 422,
          error_code: "SCHEDULE_DURATION_OUT_OF_RANGE",
          message: "La duracion de la ventana de servicio esta fuera del rango permitido",
          category: "VALIDATION",
          details: { min_hours: minHours, max_hours: maxHours, hours },
        };
      }
    };

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 40, window_seconds: 60 });

    if (payload.action === "assign") {
      const timezones = await loadTimezonesByRestaurantId([Number(payload.restaurant_id)]);
      const siteTimezone = timezones.get(Number(payload.restaurant_id)) ?? safeTimezone(null);
      const window = resolveServiceWindow(payload, siteTimezone);

      assertDurationWindow(window.scheduled_start, window.scheduled_end);

      const { data, error } = await clientUser.rpc("assign_scheduled_shift", {
        p_employee_id: payload.employee_id,
        p_restaurant_id: payload.restaurant_id,
        p_scheduled_start: window.scheduled_start,
        p_scheduled_end: window.scheduled_end,
        p_notes: payload.notes ?? null,
      });

      if (error || !data) {
        throw { code: 409, error_code: "SCHEDULE_ASSIGN_FAILED", message: "No se pudo asignar el servicio", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SCHEDULED_SHIFT_ASSIGN",
        context: {
          scheduled_shift_id: data,
          employee_id: payload.employee_id,
          restaurant_id: payload.restaurant_id,
          scheduled_start: window.scheduled_start,
          scheduled_end: window.scheduled_end,
          site_timezone: siteTimezone,
        },
        request_id,
      });

      // Echo the stored window back in the site's own clock: the caller can show
      // exactly what was saved without converting anything.
      const successPayload = {
        success: true,
        data: {
          scheduled_shift_id: data,
          scheduled_start: window.scheduled_start,
          scheduled_end: window.scheduled_end,
          timezone: siteTimezone,
          local: {
            start: formatAtSite(window.scheduled_start, siteTimezone),
            end: formatAtSite(window.scheduled_end, siteTimezone),
          },
        },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "bulk_assign") {
      const rawEntries = payload.entries as Array<ServiceWindowInput & {
        employee_id: string;
        restaurant_id: number;
        notes?: string | null;
      }>;

      // One lookup for the whole batch: every entry resolves against its own
      // site's zone, so a plan spanning several timezones stays correct.
      const batchTimezones = await loadTimezonesByRestaurantId(rawEntries.map((e) => Number(e.restaurant_id)));

      const entries = rawEntries.map((entry) => {
        const siteTimezone = batchTimezones.get(Number(entry.restaurant_id)) ?? safeTimezone(null);
        const window = resolveServiceWindow(entry, siteTimezone);
        return {
          employee_id: entry.employee_id,
          restaurant_id: entry.restaurant_id,
          notes: entry.notes,
          scheduled_start: window.scheduled_start,
          scheduled_end: window.scheduled_end,
          site_timezone: siteTimezone,
        };
      });

      for (const entry of entries) {
        assertDurationWindow(entry.scheduled_start, entry.scheduled_end);
      }

      let created = 0;
      let failed = 0;
      const created_ids: number[] = [];
      const errors: Array<Record<string, unknown>> = [];
      const created_items: Array<Record<string, unknown>> = [];

      // Each assign_scheduled_shift RPC is its own transaction, so process in
      // bounded-concurrency chunks instead of 200 sequential round-trips (audit ALTO-3).
      const CHUNK = 10;
      const results: Array<{ index: number; ok: boolean; data?: unknown; error?: string; entry: (typeof entries)[number] }> = [];
      for (let start = 0; start < entries.length; start += CHUNK) {
        const chunk = entries.slice(start, start + CHUNK);
        const chunkResults = await Promise.all(
          chunk.map(async (entry, j) => {
            const index = start + j + 1;
            try {
              const { data, error } = await clientUser.rpc("assign_scheduled_shift", {
                p_employee_id: entry.employee_id,
                p_restaurant_id: entry.restaurant_id,
                p_scheduled_start: entry.scheduled_start,
                p_scheduled_end: entry.scheduled_end,
                p_notes: entry.notes ?? null,
              });
              if (error || !data) throw error ?? { message: "No se pudo asignar servicio" };
              return { index, ok: true, data, entry };
            } catch (err) {
              return { index, ok: false, error: String((err as { message?: string })?.message ?? err ?? "Error"), entry };
            }
          })
        );
        results.push(...chunkResults);
      }

      results.sort((a, b) => a.index - b.index);
      for (const r of results) {
        if (r.ok) {
          created += 1;
          created_ids.push(Number(r.data));
          created_items.push({
            index: r.index,
            scheduled_shift_id: r.data,
            employee_id: r.entry.employee_id,
            restaurant_id: r.entry.restaurant_id,
            scheduled_start: r.entry.scheduled_start,
            scheduled_end: r.entry.scheduled_end,
            timezone: r.entry.site_timezone,
            local: {
              start: formatAtSite(r.entry.scheduled_start, r.entry.site_timezone),
              end: formatAtSite(r.entry.scheduled_end, r.entry.site_timezone),
            },
            notes: r.entry.notes ?? null,
          });
        } else {
          failed += 1;
          errors.push({ index: r.index, error: r.error, payload: r.entry });
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SCHEDULED_SHIFT_BULK_ASSIGN",
        context: {
          total: entries.length,
          created,
          failed,
        },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          total: entries.length,
          created,
          failed,
          created_ids,
          errors,
          created_items,
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "reschedule") {
      // Set inside both branches once the service's site (and so its zone) is known.
      let resolvedWindow: { scheduled_start: string; scheduled_end: string; timezone: string } | null = null;

      if (user.role === "supervisora") {
        const { data: row, error: rowError } = await clientAdmin
          .from("scheduled_shifts")
          .select("id, restaurant_id, employee_id, status, notes")
          .eq("id", payload.scheduled_shift_id)
          .single();

        if (rowError || !row) {
          throw { code: 404, error_code: "SCHEDULE_NOT_FOUND", message: "Servicio asignado no encontrado", category: "BUSINESS", details: rowError };
        }

        const timezones = await loadTimezonesByRestaurantId([Number(row.restaurant_id)]);
        const siteTimezone = timezones.get(Number(row.restaurant_id)) ?? safeTimezone(null);
        const window = resolveServiceWindow(payload, siteTimezone);
        resolvedWindow = window;

        assertDurationWindow(window.scheduled_start, window.scheduled_end);

        // 'expired' is rebookable: a service whose window closed unused is exactly
        // the one an inspector wants to move to a new date.
        if (row.status !== "scheduled" && row.status !== "expired") {
          throw { code: 409, message: "Solo se puede reprogramar un servicio programado o vencido", category: "BUSINESS" };
        }

        const newNotes = payload.notes ? payload.notes.trim() : null;
        const { error: assignmentError } = await clientAdmin
          .from("restaurant_employees")
          .upsert(
            {
              restaurant_id: row.restaurant_id,
              user_id: row.employee_id,
            },
            { onConflict: "restaurant_id,user_id" }
          );

        if (assignmentError) {
          throw { code: 409, message: "No se pudo habilitar el sitio para el empleado", category: "BUSINESS", details: assignmentError };
        }

        const { error: updateError } = await clientAdmin
          .from("scheduled_shifts")
          .update({
            scheduled_start: window.scheduled_start,
            scheduled_end: window.scheduled_end,
            // Rebooking puts an expired service back in play.
            status: "scheduled",
            notes: newNotes || row.notes || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", payload.scheduled_shift_id);

        if (updateError) {
          throw { code: 409, error_code: "SCHEDULE_RESCHEDULE_FAILED", message: "No se pudo reprogramar el servicio", category: "BUSINESS", details: updateError };
        }
      } else {
        const { data: row, error: rowError } = await clientUser
          .from("scheduled_shifts")
          .select("id, restaurant_id")
          .eq("id", payload.scheduled_shift_id)
          .single();

        if (rowError || !row) {
          throw { code: 404, error_code: "SCHEDULE_NOT_FOUND", message: "Servicio asignado no encontrado", category: "BUSINESS", details: rowError };
        }

        const timezones = await loadTimezonesByRestaurantId([Number(row.restaurant_id)]);
        const siteTimezone = timezones.get(Number(row.restaurant_id)) ?? safeTimezone(null);
        const window = resolveServiceWindow(payload, siteTimezone);
        resolvedWindow = window;

        assertDurationWindow(window.scheduled_start, window.scheduled_end);

        const { error } = await clientUser.rpc("reschedule_scheduled_shift", {
          p_scheduled_shift_id: payload.scheduled_shift_id,
          p_scheduled_start: window.scheduled_start,
          p_scheduled_end: window.scheduled_end,
          p_notes: payload.notes ?? null,
        });

        if (error) {
          throw { code: 409, message: "No se pudo reprogramar servicio", category: "BUSINESS", details: error };
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SCHEDULED_SHIFT_RESCHEDULE",
        context: {
          scheduled_shift_id: payload.scheduled_shift_id,
          scheduled_start: resolvedWindow?.scheduled_start ?? null,
          scheduled_end: resolvedWindow?.scheduled_end ?? null,
          site_timezone: resolvedWindow?.timezone ?? null,
        },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          scheduled_shift_id: payload.scheduled_shift_id,
          scheduled_start: resolvedWindow?.scheduled_start ?? null,
          scheduled_end: resolvedWindow?.scheduled_end ?? null,
          timezone: resolvedWindow?.timezone ?? null,
          local: resolvedWindow
            ? {
                start: formatAtSite(resolvedWindow.scheduled_start, resolvedWindow.timezone),
                end: formatAtSite(resolvedWindow.scheduled_end, resolvedWindow.timezone),
              }
            : null,
        },
        error: null,
        request_id,
      };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "cancel") {
      if (user.role === "supervisora") {
        const { data: row, error: rowError } = await clientAdmin
          .from("scheduled_shifts")
          .select("id, restaurant_id, status, notes")
          .eq("id", payload.scheduled_shift_id)
          .single();

        if (rowError || !row) {
          throw { code: 404, error_code: "SCHEDULE_NOT_FOUND", message: "Servicio asignado no encontrado", category: "BUSINESS", details: rowError };
        }

        if (!["scheduled", "started"].includes(String(row.status))) {
          throw { code: 409, message: "Solo se pueden cancelar servicios programados o iniciados", category: "BUSINESS" };
        }

        const reason = payload.reason?.trim();
        const notes =
          reason == null || reason === ""
            ? row.notes
            : row.notes == null || row.notes === ""
              ? `[CANCELLED] ${reason}`
              : `${row.notes}\n[CANCELLED] ${reason}`;

        const { error: updateError } = await clientAdmin
          .from("scheduled_shifts")
          .update({ status: "cancelled", notes, updated_at: new Date().toISOString() })
          .eq("id", payload.scheduled_shift_id);

        if (updateError) {
          throw { code: 409, error_code: "SCHEDULE_CANCEL_FAILED", message: "No se pudo cancelar el servicio", category: "BUSINESS", details: updateError };
        }
      } else {
        const { data: row, error: rowError } = await clientUser
          .from("scheduled_shifts")
          .select("id, restaurant_id")
          .eq("id", payload.scheduled_shift_id)
          .single();

        if (rowError || !row) {
          throw { code: 404, error_code: "SCHEDULE_NOT_FOUND", message: "Servicio asignado no encontrado", category: "BUSINESS", details: rowError };
        }

        const { error } = await clientUser.rpc("cancel_scheduled_shift", {
          p_scheduled_shift_id: payload.scheduled_shift_id,
          p_reason: payload.reason ?? null,
        });

        if (error) {
          throw { code: 409, message: "No se pudo cancelar servicio", category: "BUSINESS", details: error };
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SCHEDULED_SHIFT_CANCEL",
        context: {
          scheduled_shift_id: payload.scheduled_shift_id,
          reason: payload.reason ?? null,
        },
        request_id,
      });

      const successPayload = { success: true, data: { scheduled_shift_id: payload.scheduled_shift_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    const listClient = user.role === "supervisora" ? clientAdmin : clientUser;
    let query = listClient
      .from("scheduled_shifts")
      .select("id, employee_id, restaurant_id, scheduled_start, scheduled_end, status, notes, started_shift_id, created_by, created_at, updated_at, restaurants(name, timezone, city, state)")
      .order("scheduled_start", { ascending: false })
      .limit(payload.limit);

    if (payload.employee_id) query = query.eq("employee_id", payload.employee_id);
    if (payload.restaurant_id) query = query.eq("restaurant_id", payload.restaurant_id);
    if (payload.status) query = query.eq("status", payload.status);
    if (payload.from) query = query.gte("scheduled_start", payload.from);
    if (payload.to) query = query.lte("scheduled_end", payload.to);

    const { data, error } = await query;
    if (error) {
      throw { code: 409, error_code: "SCHEDULE_LIST_FAILED", message: "No se pudo listar la agenda", category: "BUSINESS", details: error };
    }

    // Flatten the embedded restaurant so the frontend can render each row in the
    // restaurant's local timezone without a second lookup.
    const items = (data ?? []).map((row: Record<string, unknown>) => {
      const restaurant = (row.restaurants ?? null) as { name?: string; timezone?: string | null; city?: string | null; state?: string | null } | null;
      const { restaurants: _embedded, ...rest } = row;
      return {
        ...rest,
        restaurant_name: restaurant?.name ?? null,
        restaurant_timezone: restaurant?.timezone ?? null,
        restaurant_city: restaurant?.city ?? null,
        restaurant_state: restaurant?.state ?? null,
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
