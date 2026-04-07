// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { ensureSupervisorRestaurantAccess } from "../_shared/scopeGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "reports_manage";

const listShiftsAction = z.object({
  action: z.literal("list_shifts"),
  from: z.string().min(8),
  to: z.string().min(8),
  restaurant_id: z.number().int().positive().optional(),
  employee_id: z.string().uuid().optional(),
  supervisor_id: z.string().uuid().optional(),
  status: z.enum(["activo", "finalizado", "aprobado", "rechazado"]).optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});

const listHistoryAction = z.object({
  action: z.literal("list_history"),
  limit: z.number().int().min(1).max(500).default(100),
});

const payloadSchema = z.discriminatedUnion("action", [listShiftsAction, listHistoryAction]);

function toFromIso(value: string) {
  if (value.includes("T")) return value;
  return `${value}T00:00:00.000Z`;
}

function toToIso(value: string) {
  if (value.includes("T")) return value;
  return `${value}T23:59:59.999Z`;
}

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
  let userRole: "super_admin" | "supervisora" | "empleado" | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["super_admin", "supervisora"]);
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

    if (payload.action === "list_history") {
      let historyQuery = clientAdmin
        .from("reports")
        .select("id, restaurant_id, period_start, period_end, generated_by, url_pdf, url_excel, created_at")
        .order("created_at", { ascending: false })
        .limit(payload.limit);

      if (user.role === "supervisora") {
        const { data: scope, error: scopeError } = await clientAdmin
          .from("restaurant_employees")
          .select("restaurant_id")
          .eq("user_id", user.id);

        if (scopeError) {
          throw { code: 409, message: "No se pudo validar alcance de supervisora", category: "BUSINESS", details: scopeError };
        }

        const restaurantIds = (scope ?? []).map((r) => Number(r.restaurant_id)).filter((id) => Number.isFinite(id));
        if (restaurantIds.length === 0) {
          const successPayload = { success: true, data: { items: [] }, error: null, request_id };
          await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
          return response(true, successPayload.data, null, request_id);
        }
        historyQuery = historyQuery.in("restaurant_id", restaurantIds);
      } else if (payload.restaurant_id) {
        historyQuery = historyQuery.eq("restaurant_id", payload.restaurant_id);
      }

      const { data: history, error: historyError } = await historyQuery;

      if (historyError) {
        throw { code: 409, message: "No se pudo listar historial de reportes", category: "BUSINESS", details: historyError };
      }

      const successPayload = { success: true, data: { items: history ?? [] }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    const fromIso = toFromIso(payload.from);
    const toIso = toToIso(payload.to);

    let query = clientAdmin
      .from("shifts")
      .select("id, employee_id, restaurant_id, start_time, end_time, state, status, approved_by, rejected_by, early_end_reason")
      .gte("start_time", fromIso)
      .lte("start_time", toIso)
      .order("start_time", { ascending: false })
      .limit(payload.limit);

    if (payload.restaurant_id) {
      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
      }
      query = query.eq("restaurant_id", payload.restaurant_id);
    } else if (user.role === "supervisora") {
      const { data: scope, error: scopeError } = await clientAdmin
        .from("restaurant_employees")
        .select("restaurant_id")
        .eq("user_id", user.id);

      if (scopeError) {
        throw { code: 409, message: "No se pudo validar alcance de supervisora", category: "BUSINESS", details: scopeError };
      }

      const restaurantIds = (scope ?? []).map((r) => Number(r.restaurant_id)).filter((id) => Number.isFinite(id));
      if (restaurantIds.length === 0) {
        const successPayload = { success: true, data: { items: [] }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
        return response(true, successPayload.data, null, request_id);
      }
      query = query.in("restaurant_id", restaurantIds);
    }
    if (payload.employee_id) query = query.eq("employee_id", payload.employee_id);
    if (payload.status) query = query.eq("state", payload.status);
    if (payload.supervisor_id) {
      const supId = payload.supervisor_id;
      query = query.or(`approved_by.eq.${supId},rejected_by.eq.${supId}`);
    }

    const { data: shifts, error: shiftsError } = await query;
    if (shiftsError) {
      throw { code: 409, message: "No se pudieron listar turnos", category: "BUSINESS", details: shiftsError };
    }

    const shiftIds = [...new Set((shifts ?? []).map((s) => Number(s.id)).filter((id) => Number.isFinite(id)))];

    const scheduledRes = shiftIds.length
      ? await clientAdmin
          .from("scheduled_shifts")
          .select("started_shift_id, scheduled_start, scheduled_end")
          .in("started_shift_id", shiftIds)
      : { data: [], error: null };

    if (scheduledRes.error) {
      throw { code: 409, message: "No se pudieron cargar turnos programados", category: "BUSINESS", details: scheduledRes.error };
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

    const fromKey = fromIso.slice(0, 10);
    const toKey = toIso.slice(0, 10);
    const includeEvidenceUrls = fromKey === toKey;

    const evidenceByShift = new Map<
      number,
      { startUrls: string[]; endUrls: string[]; startEvidences: Array<Record<string, unknown>>; endEvidences: Array<Record<string, unknown>> }
    >();
    if (includeEvidenceUrls && shiftIds.length > 0) {
      const { data: photos, error: photosError } = await clientAdmin
        .from("shift_photos")
        .select("shift_id, type, storage_path, captured_at, meta, created_at")
        .in("shift_id", shiftIds)
        .in("type", ["inicio", "fin"])
        .order("created_at", { ascending: true });

      if (photosError) {
        throw { code: 409, message: "No se pudieron cargar evidencias de turnos", category: "BUSINESS", details: photosError };
      }

      const paths: string[] = [];
      const photosByShift = new Map<number, Array<{ type: string; storage_path: string; captured_at: string | null; meta: Record<string, unknown> }>>();
      for (const photo of (photos ?? []) as Array<{
        shift_id: number;
        type: string;
        storage_path: string | null;
        captured_at: string | null;
        meta: Record<string, unknown> | null;
      }>) {
        if (!photo.storage_path) continue;
        const shiftId = Number(photo.shift_id);
        if (!Number.isFinite(shiftId)) continue;
        const list = photosByShift.get(shiftId) ?? [];
        list.push({
          type: photo.type,
          storage_path: photo.storage_path,
          captured_at: photo.captured_at ?? null,
          meta: (photo.meta && typeof photo.meta === "object") ? (photo.meta as Record<string, unknown>) : {},
        });
        photosByShift.set(shiftId, list);
        paths.push(photo.storage_path);
      }

      const uniquePaths = [...new Set(paths)];
      const signedMap = new Map<string, string>();
      if (uniquePaths.length > 0) {
        const { data: signedUrls, error: signedError } = await clientAdmin.storage
          .from("shift-evidence")
          .createSignedUrls(uniquePaths, 60 * 60);

        if (signedError) {
          throw { code: 500, message: "No se pudieron firmar evidencias", category: "SYSTEM", details: signedError };
        }

        for (const item of (signedUrls ?? []) as Array<{ path: string; signedUrl?: string | null }>) {
          if (item?.signedUrl) signedMap.set(item.path, item.signedUrl);
        }
      }

      for (const [shiftId, list] of photosByShift.entries()) {
        const startUrls: string[] = [];
        const endUrls: string[] = [];
        const startEvidences: Array<Record<string, unknown>> = [];
        const endEvidences: Array<Record<string, unknown>> = [];

        for (const item of list) {
          const url = signedMap.get(item.storage_path);
          if (!url) continue;
          const areaLabel = typeof item.meta.area_label === "string" ? item.meta.area_label : null;
          const subareaLabel = typeof item.meta.subarea_label === "string" ? item.meta.subarea_label : null;
          const photoLabel = typeof item.meta.photo_label === "string" ? item.meta.photo_label : null;

          const payload = {
            url,
            captured_at: item.captured_at ?? null,
            area_label: areaLabel,
            subarea_label: subareaLabel,
            photo_label: photoLabel,
          };

          if (item.type === "inicio") {
            startUrls.push(url);
            startEvidences.push(payload);
          } else if (item.type === "fin") {
            endUrls.push(url);
            endEvidences.push(payload);
          }
        }

        evidenceByShift.set(shiftId, { startUrls, endUrls, startEvidences, endEvidences });
      }
    }

    const items = (shifts ?? []).map((s) => {
      const scheduled = scheduledByShiftId.get(Number(s.id));
      const scheduled_hours = diffHours(String(scheduled?.scheduled_start ?? null), String(scheduled?.scheduled_end ?? null));
      const hours_worked = diffHours(String(s.start_time ?? null), String(s.end_time ?? null));
      const ended_early =
        !!scheduled?.scheduled_end &&
        !!s.end_time &&
        new Date(String(s.end_time)).getTime() < new Date(String(scheduled.scheduled_end)).getTime();
      const evidence = evidenceByShift.get(Number(s.id));
      return {
        ...s,
        scheduled_start: scheduled?.scheduled_start ?? null,
        scheduled_end: scheduled?.scheduled_end ?? null,
        scheduled_hours,
        hours_worked,
        worked_hours: hours_worked,
        ended_early,
        early_end_reason: (s as { early_end_reason?: string | null }).early_end_reason ?? null,
        start_evidence_urls: evidence?.startUrls ?? [],
        end_evidence_urls: evidence?.endUrls ?? [],
        start_evidences: evidence?.startEvidences ?? [],
        end_evidences: evidence?.endEvidences ?? [],
      };
    });

    const totalWorkedHours = items.reduce((acc, row) => acc + (row.hours_worked ?? 0), 0);
    const totalScheduledHours = items.reduce((acc, row) => acc + (row.scheduled_hours ?? 0), 0);

    const successPayload = {
      success: true,
      data: {
        items,
        total_worked_hours: Number(totalWorkedHours.toFixed(2)),
        total_scheduled_hours: Number(totalScheduledHours.toFixed(2)),
        restaurant_worked_hours_total: Number(totalWorkedHours.toFixed(2)),
        restaurant_scheduled_hours_total: Number(totalScheduledHours.toFixed(2)),
      },
      error: null,
      request_id,
    };
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
