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
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";

const endpoint = "operational_tasks_manage";
const evidenceBucket = "shift-evidence";

const createAction = z.object({
  action: z.literal("create"),
  shift_id: z.number().int().positive(),
  assigned_employee_id: z.string().uuid(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(5).max(5000),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  due_at: z.string().datetime().optional().nullable(),
});

const requestManifestUploadAction = z.object({
  action: z.literal("request_manifest_upload"),
  task_id: z.number().int().positive(),
});

const completeAction = z.object({
  action: z.literal("complete"),
  task_id: z.number().int().positive(),
  evidence_path: z.string().min(20).max(500),
});

const listMyOpenAction = z.object({
  action: z.literal("list_my_open"),
  shift_id: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const listSupervisionAction = z.object({
  action: z.literal("list_supervision"),
  restaurant_id: z.number().int().positive().optional(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const payloadSchema = z.discriminatedUnion("action", [
  createAction,
  requestManifestUploadAction,
  completeAction,
  listMyOpenAction,
  listSupervisionAction,
]);

async function sha256Hex(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

    if (payload.action === "create") {
      roleGuard(user, ["supervisora", "super_admin"]);

      if (user.role === "supervisora") {
        const { data: shift, error: shiftError } = await clientUser
          .from("shifts")
          .select("id, restaurant_id")
          .eq("id", payload.shift_id)
          .single();

        if (shiftError || !shift) {
          throw { code: 404, message: "Turno no encontrado", category: "BUSINESS", details: shiftError };
        }

        await ensureSupervisorRestaurantAccess(user.id, shift.restaurant_id as number);
      }

      const { data, error } = await clientUser.rpc("create_operational_task", {
        p_shift_id: payload.shift_id,
        p_assigned_employee_id: payload.assigned_employee_id,
        p_title: payload.title,
        p_description: payload.description,
        p_priority: payload.priority,
        p_due_at: payload.due_at ?? null,
      });

      if (error || !data) {
        throw { code: 409, message: "No se pudo crear tarea operativa", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "OPERATIONAL_TASK_CREATE",
        context: {
          task_id: data,
          shift_id: payload.shift_id,
          assigned_employee_id: payload.assigned_employee_id,
          priority: payload.priority,
        },
        request_id,
      });

      const successPayload = { success: true, data: { task_id: data }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "request_manifest_upload") {
      roleGuard(user, ["empleado", "supervisora", "super_admin"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, assigned_employee_id")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      const actorForPath = user.role === "empleado" ? user.id : (task.assigned_employee_id as string);
      const path = `users/${actorForPath}/task-manifest/${payload.task_id}/${request_id}.json`;
      const { data, error } = await clientAdmin.storage.from(evidenceBucket).createSignedUploadUrl(path);
      if (error || !data) {
        throw { code: 500, message: "No se pudo generar URL de carga para manifest", category: "SYSTEM", details: error };
      }

      const successPayload = {
        success: true,
        data: {
          upload: data,
          bucket: evidenceBucket,
          path,
          required_mime: "application/json",
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "complete") {
      roleGuard(user, ["empleado", "supervisora", "super_admin"]);

      if (user.role !== "super_admin") {
        const { data: task, error: taskError } = await clientUser
          .from("operational_tasks")
          .select("id, restaurant_id")
          .eq("id", payload.task_id)
          .single();

        if (taskError || !task) {
          throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
        }

        if (user.role === "supervisora") {
          await ensureSupervisorRestaurantAccess(user.id, task.restaurant_id as number);
        }
      }

      const expectedPrefix = `users/${user.id}/task-manifest/`;
      if (user.role === "empleado" && !payload.evidence_path.startsWith(expectedPrefix)) {
        throw { code: 403, message: "Ruta de manifest invalida para el empleado", category: "PERMISSION" };
      }

      const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(evidenceBucket).download(payload.evidence_path);
      if (downloadError || !fileBlob) {
        throw { code: 422, message: "Manifest no disponible en storage", category: "VALIDATION", details: downloadError };
      }

      if (fileBlob.size <= 0 || fileBlob.size > 512 * 1024) {
        throw { code: 422, message: "Tamano de manifest invalido", category: "VALIDATION", details: { size: fileBlob.size } };
      }

      const text = await fileBlob.text();
      try {
        JSON.parse(text);
      } catch {
        throw { code: 422, message: "Manifest JSON invalido", category: "VALIDATION" };
      }

      const evidenceHash = await sha256Hex(fileBlob);

      const { error } = await clientUser.rpc("complete_operational_task", {
        p_task_id: payload.task_id,
        p_evidence_path: payload.evidence_path,
        p_evidence_hash: evidenceHash,
        p_evidence_mime_type: "application/json",
        p_evidence_size_bytes: fileBlob.size,
      });

      if (error) {
        throw { code: 409, message: "No se pudo cerrar tarea operativa", category: "BUSINESS", details: error };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "OPERATIONAL_TASK_COMPLETE",
        context: {
          task_id: payload.task_id,
          evidence_path: payload.evidence_path,
          evidence_hash: evidenceHash,
          evidence_size_bytes: fileBlob.size,
        },
        request_id,
      });

      const successPayload = { success: true, data: { task_id: payload.task_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_my_open") {
      roleGuard(user, ["empleado"]);

      let query = clientUser
        .from("operational_tasks")
        .select("id, shift_id, restaurant_id, assigned_employee_id, created_by, title, description, priority, status, due_at, resolved_at, resolved_by, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, created_at, updated_at")
        .eq("assigned_employee_id", user.id)
        .in("status", ["pending", "in_progress"])
        .order("updated_at", { ascending: false })
        .limit(payload.limit);

      if (payload.shift_id) query = query.eq("shift_id", payload.shift_id);

      const { data, error } = await query;
      if (error) {
        throw { code: 409, message: "No se pudo listar tareas abiertas", category: "BUSINESS", details: error };
      }

      const successPayload = { success: true, data: { items: data ?? [] }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    roleGuard(user, ["supervisora", "super_admin"]);

    let query = clientUser
      .from("operational_tasks")
      .select("id, shift_id, restaurant_id, assigned_employee_id, created_by, title, description, priority, status, due_at, resolved_at, resolved_by, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(payload.limit);

    if (payload.restaurant_id) {
      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
      }
      query = query.eq("restaurant_id", payload.restaurant_id);
    }

    if (payload.status) query = query.eq("status", payload.status);

    const { data, error } = await query;
    if (error) {
      throw { code: 409, message: "No se pudo listar tareas de supervision", category: "BUSINESS", details: error };
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
