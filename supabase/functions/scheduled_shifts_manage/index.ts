// @ts-nocheck
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

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 40, window_seconds: 60 });

    if (payload.action === "assign") {
      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
      }

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

      if (user.role === "supervisora") {
        const uniqueRestaurantIds = [...new Set(entries.map((e) => e.restaurant_id))];
        for (const restaurantId of uniqueRestaurantIds) {
          await ensureSupervisorRestaurantAccess(user.id, restaurantId);
        }
      }

      const { data, error } = await clientUser.rpc("bulk_assign_scheduled_shifts", {
        p_entries: entries,
      });

      if (error || !data?.[0]) {
        throw { code: 409, message: "No se pudo ejecutar programacion masiva", category: "BUSINESS", details: error };
      }

      const summary = data[0] as {
        total: number;
        created: number;
        failed: number;
        created_ids: number[];
        errors: unknown;
      };

      await safeWriteAudit({
        user_id: user.id,
        action: "SCHEDULED_SHIFT_BULK_ASSIGN",
        context: {
          total: summary.total,
          created: summary.created,
          failed: summary.failed,
        },
        request_id,
      });

      const successPayload = {
        success: true,
        data: {
          total: summary.total,
          created: summary.created,
          failed: summary.failed,
          created_ids: summary.created_ids ?? [],
          errors: summary.errors ?? [],
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "reschedule") {
      const { data: row, error: rowError } = await clientUser
        .from("scheduled_shifts")
        .select("id, restaurant_id")
        .eq("id", payload.scheduled_shift_id)
        .single();

      if (rowError || !row) {
        throw { code: 404, message: "Turno programado no encontrado", category: "BUSINESS", details: rowError };
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, row.restaurant_id as number);
      }

      const { error } = await clientUser.rpc("reschedule_scheduled_shift", {
        p_scheduled_shift_id: payload.scheduled_shift_id,
        p_scheduled_start: payload.scheduled_start,
        p_scheduled_end: payload.scheduled_end,
        p_notes: payload.notes ?? null,
      });

      if (error) {
        throw { code: 409, message: "No se pudo reprogramar turno", category: "BUSINESS", details: error };
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
      const { data: row, error: rowError } = await clientUser
        .from("scheduled_shifts")
        .select("id, restaurant_id")
        .eq("id", payload.scheduled_shift_id)
        .single();

      if (rowError || !row) {
        throw { code: 404, message: "Turno programado no encontrado", category: "BUSINESS", details: rowError };
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, row.restaurant_id as number);
      }

      const { error } = await clientUser.rpc("cancel_scheduled_shift", {
        p_scheduled_shift_id: payload.scheduled_shift_id,
        p_reason: payload.reason ?? null,
      });

      if (error) {
        throw { code: 409, message: "No se pudo cancelar turno", category: "BUSINESS", details: error };
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

    let query = clientUser
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
