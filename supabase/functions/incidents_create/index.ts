import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { getOwnedShift } from "../_shared/stateValidator.ts";
import { ensureSupervisorShiftAccess } from "../_shared/scopeGuard.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp, commonSchemas } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";
import { requireTrustedDevice } from "../_shared/deviceTrust.ts";
import { requireShiftOtpSession } from "../_shared/otp.ts";
import { notifyIncidentCreated, safeDispatchPendingEmailNotifications } from "../_shared/emailNotifications.ts";

const endpoint = "incidents_create";
const payloadSchema = z.object({
  shift_id: commonSchemas.shiftId,
  description: z.string().trim().min(5).max(5000),
  task: z
    .object({
      assigned_employee_id: z.string().uuid(),
      title: z.string().trim().min(3).max(200),
      description: z.string().trim().min(5).max(5000),
      priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
      due_at: z.string().datetime().optional().nullable(),
    })
    .optional(),
});

serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  const request_id = crypto.randomUUID();
  const startedAt = Date.now();
  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  let status = 200;
  let error_code: string | undefined;
  let userId: string | undefined;
  let idempotencyKey: string | null = null;
  let userRole: "super_admin" | "supervisora" | "empleado" | undefined;

  try {
    requireMethod(req, ["POST"]);
    const { user, clientUser } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    roleGuard(user, ["empleado", "supervisora", "super_admin"]);
    await requireAcceptedActiveLegalTerm(user.id);
    const trustedDevice = await requireTrustedDevice({ userId: user.id, req });
    await requireShiftOtpSession({ req, userId: user.id, trustedDeviceId: trustedDevice.id });

    const payload = await parseBody(req, payloadSchema);
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 25, window_seconds: 60 });

    const { shift_id, description, task } = payload;

    if (user.role === "empleado") {
      await getOwnedShift(clientUser, user.id, shift_id);
    }
    if (user.role === "supervisora") {
      await ensureSupervisorShiftAccess(user.id, shift_id);
    }

    if (task && user.role === "empleado") {
      throw { code: 403, message: "Empleado no puede crear tareas operativas", category: "PERMISSION" };
    }

    const { data, error } = await clientUser
      .from("incidents")
      .insert({
        shift_id,
        description,
        created_by: user.id,
        created_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error || !data) {
      throw { code: 409, message: "No se pudo registrar incidencia", category: "BUSINESS", details: error };
    }

    let taskId: number | null = null;
    if (task) {
      const { data: taskRpc, error: taskError } = await clientUser.rpc("create_operational_task", {
        p_shift_id: shift_id,
        p_assigned_employee_id: task.assigned_employee_id,
        p_title: task.title,
        p_description: task.description,
        p_priority: task.priority,
        p_due_at: task.due_at ?? null,
      });

      if (taskError || !taskRpc) {
        throw { code: 409, message: "Incidencia creada, pero no se pudo crear tarea", category: "BUSINESS", details: taskError };
      }

      taskId = Number(taskRpc);
    }

    await safeWriteAudit({
      user_id: user.id,
      action: "INCIDENT_CREATE",
      context: { incident_id: data.id, shift_id, task_id: taskId },
      request_id,
    });

    await notifyIncidentCreated({
      incidentId: data.id,
      shiftId: shift_id,
      actorUserId: user.id,
    });
    await safeDispatchPendingEmailNotifications({ limit: 25, maxAttempts: 5 });

    const successPayload = { success: true, data: { incident_id: data.id, task_id: taskId }, error: null, request_id };
    await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });

    return response(true, { incident_id: data.id, task_id: taskId }, null, request_id);
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

