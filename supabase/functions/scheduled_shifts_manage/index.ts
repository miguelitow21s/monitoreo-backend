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

const endpoint = "scheduled_shifts_manage";

const assignAction = z.object({
  action: z.literal("assign"),
  employee_id: z.string().uuid(),
  restaurant_id: commonSchemas.restaurantId,
  scheduled_start: z.string().datetime(),
  scheduled_end: z.string().datetime(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

const bulkAssignAction = z.object({
  action: z.literal("bulk_assign"),
  entries: z
    .array(
      z.object({
        employee_id: z.string().uuid(),
        restaurant_id: commonSchemas.restaurantId,
        scheduled_start: z.string().datetime(),
        scheduled_end: z.string().datetime(),
        notes: z.string().trim().max(1000).optional().nullable(),
      })
    )
    .min(1)
    .max(200),
});

const rescheduleAction = z.object({
  action: z.literal("reschedule"),
  scheduled_shift_id: z.number().int().positive(),
  scheduled_start: z.string().datetime(),
  scheduled_end: z.string().datetime(),
  notes: z.string().trim().max(1000).optional().nullable(),
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
  status: z.enum(["scheduled", "started", "completed", "cancelled"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const payloadSchema = z.discriminatedUnion("action", [assignAction, bulkAssignAction, rescheduleAction, cancelAction, listAction]);

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
        throw { code: 422, message: "Rango horario invalido", category: "VALIDATION" };
      }
      const hours = (end.getTime() - start.getTime()) / 3600000;
      if (hours < minHours || hours > maxHours) {
        throw {
          code: 422,
          message: "Duracion de turno fuera de rango permitido",
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
      assertDurationWindow(payload.scheduled_start, payload.scheduled_end);

      const { data, error } = await clientUser.rpc("assign_scheduled_shift", {
        p_employee_id: payload.employee_id,
        p_restaurant_id: payload.restaurant_id,
        p_scheduled_start: payload.scheduled_start,
        p_scheduled_end: payload.scheduled_end,
        p_notes: payload.notes ?? null,
      });

      if (error || !data) {
        throw { code: 409, message: "No se pudo programar turno", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SCHEDULED_SHIFT_ASSIGN",
        context: {
          scheduled_shift_id: data,
          employee_id: payload.employee_id,
          restaurant_id: payload.restaurant_id,
          scheduled_start: payload.scheduled_start,
          scheduled_end: payload.scheduled_end,
        },
        request_id,
      });

      const successPayload = { success: true, data: { scheduled_shift_id: data }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "bulk_assign") {
      const entries = payload.entries as Array<{
        employee_id: string;
        restaurant_id: number;
        scheduled_start: string;
        scheduled_end: string;
        notes?: string | null;
      }>;

      for (const entry of entries) {
        assertDurationWindow(entry.scheduled_start, entry.scheduled_end);
      }

      let created = 0;
      let failed = 0;
      const created_ids: number[] = [];
      const errors: Array<Record<string, unknown>> = [];
      const created_items: Array<Record<string, unknown>> = [];

      for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        const index = i + 1;
        try {
          const { data, error } = await clientUser.rpc("assign_scheduled_shift", {
            p_employee_id: entry.employee_id,
            p_restaurant_id: entry.restaurant_id,
            p_scheduled_start: entry.scheduled_start,
            p_scheduled_end: entry.scheduled_end,
            p_notes: entry.notes ?? null,
          });

          if (error || !data) {
            throw error ?? { message: "No se pudo programar turno" };
          }

          created += 1;
          created_ids.push(Number(data));
          created_items.push({
            index,
            scheduled_shift_id: data,
            employee_id: entry.employee_id,
            restaurant_id: entry.restaurant_id,
            scheduled_start: entry.scheduled_start,
            scheduled_end: entry.scheduled_end,
            notes: entry.notes ?? null,
          });
        } catch (err) {
          failed += 1;
          const errorMessage = String((err as { message?: string })?.message ?? err ?? "Error");
          errors.push({
            index,
            error: errorMessage,
            payload: entry,
          });
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
      if (user.role === "supervisora") {
        const { data: row, error: rowError } = await clientAdmin
          .from("scheduled_shifts")
          .select("id, restaurant_id, employee_id, status, notes")
          .eq("id", payload.scheduled_shift_id)
          .single();

        if (rowError || !row) {
          throw { code: 404, message: "Turno programado no encontrado", category: "BUSINESS", details: rowError };
        }

        assertDurationWindow(payload.scheduled_start, payload.scheduled_end);

        if (row.status !== "scheduled") {
          throw { code: 409, message: "Solo se puede reprogramar un turno en estado scheduled", category: "BUSINESS" };
        }

        const { data: overlap, error: overlapError } = await clientAdmin
          .from("scheduled_shifts")
          .select("id")
          .eq("employee_id", row.employee_id)
          .in("status", ["scheduled", "started"])
          .lt("scheduled_start", payload.scheduled_end)
          .gt("scheduled_end", payload.scheduled_start)
          .neq("id", payload.scheduled_shift_id)
          .limit(1);

        if (overlapError) {
          throw { code: 409, message: "No se pudo validar cruce de turnos", category: "BUSINESS", details: overlapError };
        }

        if (overlap && overlap.length > 0) {
          throw { code: 409, message: "El empleado ya tiene un turno programado en ese rango", category: "BUSINESS" };
        }

        const newNotes = payload.notes ? payload.notes.trim() : null;
        const { error: updateError } = await clientAdmin
          .from("scheduled_shifts")
          .update({
            scheduled_start: payload.scheduled_start,
            scheduled_end: payload.scheduled_end,
            notes: newNotes || row.notes || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", payload.scheduled_shift_id);

        if (updateError) {
          throw { code: 409, message: "No se pudo reprogramar turno", category: "BUSINESS", details: updateError };
        }
      } else {
        const { data: row, error: rowError } = await clientUser
          .from("scheduled_shifts")
          .select("id, restaurant_id")
          .eq("id", payload.scheduled_shift_id)
          .single();

        if (rowError || !row) {
          throw { code: 404, message: "Turno programado no encontrado", category: "BUSINESS", details: rowError };
        }

        assertDurationWindow(payload.scheduled_start, payload.scheduled_end);

        const { error } = await clientUser.rpc("reschedule_scheduled_shift", {
          p_scheduled_shift_id: payload.scheduled_shift_id,
          p_scheduled_start: payload.scheduled_start,
          p_scheduled_end: payload.scheduled_end,
          p_notes: payload.notes ?? null,
        });

        if (error) {
          throw { code: 409, message: "No se pudo reprogramar turno", category: "BUSINESS", details: error };
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "SCHEDULED_SHIFT_RESCHEDULE",
        context: {
          scheduled_shift_id: payload.scheduled_shift_id,
          scheduled_start: payload.scheduled_start,
          scheduled_end: payload.scheduled_end,
        },
        request_id,
      });

      const successPayload = { success: true, data: { scheduled_shift_id: payload.scheduled_shift_id }, error: null, request_id };
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
          throw { code: 404, message: "Turno programado no encontrado", category: "BUSINESS", details: rowError };
        }

        if (!["scheduled", "started"].includes(String(row.status))) {
          throw { code: 409, message: "Solo se pueden cancelar turnos scheduled o started", category: "BUSINESS" };
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
          throw { code: 409, message: "No se pudo cancelar turno", category: "BUSINESS", details: updateError };
        }
      } else {
        const { data: row, error: rowError } = await clientUser
          .from("scheduled_shifts")
          .select("id, restaurant_id")
          .eq("id", payload.scheduled_shift_id)
          .single();

        if (rowError || !row) {
          throw { code: 404, message: "Turno programado no encontrado", category: "BUSINESS", details: rowError };
        }

        const { error } = await clientUser.rpc("cancel_scheduled_shift", {
          p_scheduled_shift_id: payload.scheduled_shift_id,
          p_reason: payload.reason ?? null,
        });

        if (error) {
          throw { code: 409, message: "No se pudo cancelar turno", category: "BUSINESS", details: error };
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
      .select("id, employee_id, restaurant_id, scheduled_start, scheduled_end, status, notes, started_shift_id, created_by, created_at, updated_at")
      .order("scheduled_start", { ascending: false })
      .limit(payload.limit);

    if (payload.employee_id) query = query.eq("employee_id", payload.employee_id);
    if (payload.restaurant_id) query = query.eq("restaurant_id", payload.restaurant_id);
    if (payload.status) query = query.eq("status", payload.status);
    if (payload.from) query = query.gte("scheduled_start", payload.from);
    if (payload.to) query = query.lte("scheduled_end", payload.to);

    const { data, error } = await query;
    if (error) {
      throw { code: 409, message: "No se pudo listar agenda", category: "BUSINESS", details: error };
    }

    const successPayload = { success: true, data: { items: data ?? [] }, error: null, request_id };
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
