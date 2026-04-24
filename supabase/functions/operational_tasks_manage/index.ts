// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { authGuard } from "../_shared/authGuard.ts";
import { roleGuard } from "../_shared/roleGuard.ts";
import { requireAcceptedActiveLegalTerm } from "../_shared/legalGuard.ts";
import { clientAdmin } from "../_shared/supabaseClient.ts";
import { requireMethod, parseBody, requireIdempotencyKey, getClientIp } from "../_shared/validation.ts";
import { rateLimiter } from "../_shared/rateLimiter.ts";
import { claimIdempotency, replayIdempotentResponse, safeFinalizeIdempotency } from "../_shared/idempotency.ts";
import { errorHandler } from "../_shared/errorHandler.ts";
import { response, handleCorsPreflight } from "../_shared/response.ts";
import { logRequest } from "../_shared/logger.ts";
import { safeWriteAudit } from "../_shared/auditWriter.ts";
import { hashCanonicalJson } from "../_shared/crypto.ts";
import { getSystemSettings } from "../_shared/systemSettings.ts";

const endpoint = "operational_tasks_manage";
const evidenceBucket = "shift-evidence";

const createAction = z.object({
  action: z.literal("create"),
  shift_id: z.number().int().positive().optional(),
  scheduled_shift_id: z.number().int().positive().optional(),
  restaurant_id: z.number().int().positive().optional(),
  task_scope: z.enum(["employee", "restaurant"]).optional(),
  scope: z.enum(["employee", "restaurant"]).optional(),
  assigned_employee_id: z.string().uuid().optional(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(5).max(5000),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  due_at: z.string().datetime().optional().nullable(),
  requires_evidence: z.boolean().optional(),
  origin_page: z.string().trim().max(100).optional(),
});

const updateAction = z.object({
  action: z.literal("update"),
  task_id: z.number().int().positive(),
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(5).max(5000).optional(),
  priority: z.enum(["low", "normal", "high", "critical"]).optional(),
  due_at: z.string().datetime().optional().nullable(),
  assigned_employee_id: z.string().uuid().optional(),
  requires_evidence: z.boolean().optional(),
});

const cancelAction = z.object({
  action: z.literal("cancel"),
  task_id: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500).optional(),
});

const markInProgressAction = z.object({
  action: z.literal("mark_in_progress"),
  task_id: z.number().int().positive(),
});

const closeAction = z.object({
  action: z.literal("close"),
  task_id: z.number().int().positive(),
  reason: z.string().trim().min(3).max(500).optional(),
  notes: z.string().trim().min(3).max(5000).optional(),
});

const requestManifestUploadAction = z.object({
  action: z.literal("request_manifest_upload"),
  task_id: z.number().int().positive(),
});

const requestEvidenceUploadAction = z.object({
  action: z.literal("request_evidence_upload"),
  task_id: z.number().int().positive(),
  mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]).default("image/jpeg"),
});

const completeAction = z.object({
  action: z.literal("complete"),
  task_id: z.number().int().positive(),
  evidence_path: z.string().min(20).max(500),
  notes: z.string().trim().min(3).max(5000).optional(),
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
  updateAction,
  cancelAction,
  markInProgressAction,
  closeAction,
  requestManifestUploadAction,
  requestEvidenceUploadAction,
  completeAction,
  listMyOpenAction,
  listSupervisionAction,
]);

async function sha256Hex(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mimeToExtension(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "json";
}

function inferMimeType(path: string, blobType: string) {
  const byBlob = (blobType || "").toLowerCase();
  if (byBlob) return byBlob;

  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function ensureEmployeeUser(employeeId: string) {
  const { data, error } = await clientAdmin
    .from("profiles")
    .select("id, role, is_active")
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

async function ensureSupervisorRestaurantAccess(supervisorId: string, restaurantId: number) {
  const { data: supervisor, error: supervisorError } = await clientAdmin
    .from("profiles")
    .select("id, role, is_active")
    .eq("id", supervisorId)
    .maybeSingle();

  if (supervisorError || !supervisor) {
    throw { code: 403, message: "Supervisora no valida", category: "PERMISSION", details: supervisorError };
  }

  if (String(supervisor.role) !== "supervisora" || supervisor.is_active === false) {
    throw { code: 403, message: "Supervisora sin permiso", category: "PERMISSION" };
  }

  const { data: restaurant, error: restaurantError } = await clientAdmin
    .from("restaurants")
    .select("id")
    .eq("id", restaurantId)
    .maybeSingle();

  if (restaurantError || !restaurant) {
    throw { code: 404, message: "Restaurante no encontrado", category: "BUSINESS", details: restaurantError };
  }
}

async function ensureEmployeeRestaurantAccess(employeeId: string, restaurantId: number) {
  const { data: link } = await clientAdmin
    .from("restaurant_employees")
    .select("restaurant_id")
    .eq("user_id", employeeId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (!link) {
    throw {
      code: 403,
      message: "No tienes acceso a tareas de este restaurante",
      category: "PERMISSION",
      details: { diagnostic_code: "RESTAURANT_FORBIDDEN" },
    };
  }
}

async function ensureActiveShiftAtRestaurant(employeeId: string, restaurantId: number) {
  const { data: activeShift } = await clientAdmin
    .from("shifts")
    .select("id")
    .eq("employee_id", employeeId)
    .eq("restaurant_id", restaurantId)
    .eq("state", "activo")
    .maybeSingle();

  if (!activeShift) {
    throw {
      code: 422,
      message: "Debes tener un turno activo en este restaurante para operar la tarea",
      category: "BUSINESS",
      details: { diagnostic_code: "NO_ACTIVE_SHIFT" },
    };
  }
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

    const settings = await getSystemSettings(clientAdmin);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 40, window_seconds: 60 });

    if (payload.action === "create") {
      roleGuard(user, ["supervisora", "super_admin"]);

      const isRestaurantScope = payload.task_scope === "restaurant" || payload.scope === "restaurant";

      if (isRestaurantScope) {
        if (!payload.restaurant_id) {
          throw {
            code: 422,
            message: "Se requiere restaurant_id para tareas de alcance restaurante",
            category: "VALIDATION",
            details: { diagnostic_code: "RESTAURANT_NOT_FOUND" },
          };
        }

        const { data: restaurant, error: restaurantError } = await clientAdmin
          .from("restaurants")
          .select("id")
          .eq("id", payload.restaurant_id)
          .maybeSingle();

        if (restaurantError || !restaurant) {
          throw {
            code: 404,
            message: "Restaurante no encontrado",
            category: "BUSINESS",
            details: { diagnostic_code: "RESTAURANT_NOT_FOUND", restaurant_id: payload.restaurant_id },
          };
        }

        if (user.role === "supervisora") {
          await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
        }

        const nowIso = new Date().toISOString();
        const { data: createdTask, error: createError } = await clientUser
          .from("operational_tasks")
          .insert({
            shift_id: null,
            scheduled_shift_id: null,
            restaurant_id: payload.restaurant_id,
            task_scope: "restaurant",
            assigned_employee_id: null,
            created_by: user.id,
            title: payload.title,
            description: payload.description,
            priority: payload.priority,
            status: "pending",
            due_at: payload.due_at ?? null,
            requires_evidence: payload.requires_evidence ?? true,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .select("id")
          .single();

        if (createError || !createdTask) {
          throw {
            code: 409,
            message: "No se pudo crear tarea de restaurante",
            category: "BUSINESS",
            details: {
              diagnostic_code: "OP_TASK_INSERT_RESTAURANT_FAILED",
              restaurant_id: payload.restaurant_id,
              error: createError,
            },
          };
        }

        await safeWriteAudit({
          user_id: user.id,
          action: "OPERATIONAL_TASK_CREATE",
          context: {
            task_id: createdTask.id,
            restaurant_id: payload.restaurant_id,
            task_scope: "restaurant",
            priority: payload.priority,
            origin_page: payload.origin_page ?? null,
          },
          request_id,
        });

        const successPayload = { success: true, data: { task_id: createdTask.id }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
        return response(true, successPayload.data, null, request_id);
      }

      // Employee-scoped task (legacy behavior: requires shift and assigned employee)
      const hasShiftId = typeof payload.shift_id === "number";
      const hasScheduledShiftId = typeof payload.scheduled_shift_id === "number";

      if (hasShiftId === hasScheduledShiftId) {
        throw {
          code: 422,
          message: "Debe enviar shift_id o scheduled_shift_id (solo uno)",
          category: "VALIDATION",
          details: { diagnostic_code: "TASK_SCOPE_NOT_SUPPORTED" },
        };
      }

      if (!payload.assigned_employee_id) {
        throw {
          code: 422,
          message: "Se requiere assigned_employee_id para tareas de empleado",
          category: "VALIDATION",
        };
      }

      await ensureEmployeeUser(payload.assigned_employee_id);

      if (hasScheduledShiftId) {
        const { data: scheduledShift, error: scheduledShiftAdminError } = await clientAdmin
          .from("scheduled_shifts")
          .select("id, restaurant_id, employee_id, status")
          .eq("id", payload.scheduled_shift_id)
          .maybeSingle();

        if (scheduledShiftAdminError) {
          throw {
            code: 409,
            message: "No se pudo validar turno programado",
            category: "BUSINESS",
            details: {
              diagnostic_code: "SCHEDULED_SHIFT_LOOKUP_FAILED",
              scheduled_shift_id: payload.scheduled_shift_id,
              source: "admin_lookup",
              error: scheduledShiftAdminError,
            },
          };
        }

        if (!scheduledShift) {
          throw {
            code: 404,
            message: "Turno programado no existe en este ambiente",
            category: "BUSINESS",
            details: {
              diagnostic_code: "SCHEDULED_SHIFT_NOT_FOUND",
              scheduled_shift_id: payload.scheduled_shift_id,
            },
          };
        }

        if (scheduledShift.status !== "scheduled") {
          throw {
            code: 409,
            message: "Solo se pueden asignar tareas a turnos programados",
            category: "BUSINESS",
            details: {
              diagnostic_code: "SCHEDULED_SHIFT_INVALID_STATUS",
              scheduled_shift_id: payload.scheduled_shift_id,
              current_status: scheduledShift.status,
              expected_status: "scheduled",
            },
          };
        }

        if (String(scheduledShift.employee_id) !== payload.assigned_employee_id) {
          throw {
            code: 422,
            message: "Empleado no coincide con el turno programado",
            category: "VALIDATION",
            details: {
              diagnostic_code: "SCHEDULED_SHIFT_EMPLOYEE_MISMATCH",
              scheduled_shift_id: payload.scheduled_shift_id,
              expected_employee_id: String(scheduledShift.employee_id),
              received_employee_id: payload.assigned_employee_id,
            },
          };
        }

        const nowIso = new Date().toISOString();
        const { data: createdTask, error: createScheduledError } = await clientUser
          .from("operational_tasks")
          .insert({
            shift_id: null,
            scheduled_shift_id: payload.scheduled_shift_id,
            restaurant_id: scheduledShift.restaurant_id,
            assigned_employee_id: payload.assigned_employee_id,
            created_by: user.id,
            title: payload.title,
            description: payload.description,
            priority: payload.priority,
            status: "pending",
            due_at: payload.due_at ?? null,
            requires_evidence: payload.requires_evidence ?? true,
            created_at: nowIso,
            updated_at: nowIso,
          })
          .select("id")
          .single();

        if (createScheduledError || !createdTask) {
          const errorMessage = String(createScheduledError?.message ?? "").toLowerCase();
          const shouldFallbackToRpc = errorMessage.includes("turno invalido para crear tarea");

          if (shouldFallbackToRpc) {
            const { data: taskIdByRpc, error: rpcCreateError } = await clientUser.rpc("create_operational_task_for_schedule", {
              p_scheduled_shift_id: payload.scheduled_shift_id,
              p_assigned_employee_id: payload.assigned_employee_id,
              p_title: payload.title,
              p_description: payload.description,
              p_priority: payload.priority,
              p_due_at: payload.due_at ?? null,
              p_requires_evidence: payload.requires_evidence ?? true,
            });

            if (!rpcCreateError && taskIdByRpc) {
              await safeWriteAudit({
                user_id: user.id,
                action: "OPERATIONAL_TASK_CREATE",
                context: {
                  task_id: taskIdByRpc,
                  scheduled_shift_id: payload.scheduled_shift_id,
                  assigned_employee_id: payload.assigned_employee_id,
                  priority: payload.priority,
                  path: "fallback_rpc_create_operational_task_for_schedule",
                },
                request_id,
              });

              const successPayload = { success: true, data: { task_id: taskIdByRpc }, error: null, request_id };
              await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
              return response(true, successPayload.data, null, request_id);
            }

            throw {
              code: 409,
              message: "No se pudo crear tarea operativa",
              category: "BUSINESS",
              details: {
                diagnostic_code: "OP_TASK_INSERT_FALLBACK_RPC_FAILED",
                scheduled_shift_id: payload.scheduled_shift_id,
                assigned_employee_id: payload.assigned_employee_id,
                insert_error: createScheduledError,
                rpc_error: rpcCreateError,
              },
            };
          }

          throw {
            code: 409,
            message: "No se pudo crear tarea operativa",
            category: "BUSINESS",
            details: {
              diagnostic_code: "OP_TASK_INSERT_FROM_SCHEDULE_FAILED",
              scheduled_shift_id: payload.scheduled_shift_id,
              assigned_employee_id: payload.assigned_employee_id,
              error: createScheduledError,
            },
          };
        }

        await safeWriteAudit({
          user_id: user.id,
          action: "OPERATIONAL_TASK_CREATE",
          context: {
            task_id: createdTask.id,
            scheduled_shift_id: payload.scheduled_shift_id,
            assigned_employee_id: payload.assigned_employee_id,
            priority: payload.priority,
            path: "insert_operational_tasks_from_schedule",
          },
          request_id,
        });

        const successPayload = { success: true, data: { task_id: createdTask.id }, error: null, request_id };
        await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
        return response(true, successPayload.data, null, request_id);
      }

      const { data: shift, error: shiftError } = await clientAdmin
        .from("shifts")
        .select("id, restaurant_id")
        .eq("id", payload.shift_id)
        .maybeSingle();

      if (shiftError || !shift) {
        throw {
          code: 404,
          message: "Turno no encontrado",
          category: "BUSINESS",
          details: {
            diagnostic_code: "SHIFT_NOT_FOUND",
            shift_id: payload.shift_id,
            error: shiftError,
          },
        };
      }

      const nowIso = new Date().toISOString();
      const { data, error } = await clientUser
        .from("operational_tasks")
        .insert({
          shift_id: payload.shift_id,
          scheduled_shift_id: null,
          restaurant_id: shift.restaurant_id,
          assigned_employee_id: payload.assigned_employee_id,
          created_by: user.id,
          title: payload.title,
          description: payload.description,
          priority: payload.priority,
          status: "pending",
          due_at: payload.due_at ?? null,
          requires_evidence: payload.requires_evidence ?? true,
          created_at: nowIso,
          updated_at: nowIso,
        })
        .select("id")
        .single();

      if (error || !data) {
        throw {
          code: 409,
          message: "No se pudo crear tarea operativa",
          category: "BUSINESS",
          details: {
            diagnostic_code: "OP_TASK_INSERT_FROM_SHIFT_FAILED",
            shift_id: payload.shift_id,
            assigned_employee_id: payload.assigned_employee_id,
            error,
          },
        };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "OPERATIONAL_TASK_CREATE",
        context: {
          task_id: data.id,
          shift_id: payload.shift_id,
          assigned_employee_id: payload.assigned_employee_id,
          priority: payload.priority,
        },
        request_id,
      });

      const successPayload = { success: true, data: { task_id: data.id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "update") {
      roleGuard(user, ["supervisora", "super_admin"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, restaurant_id, status")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      if (task.status === "completed" || task.status === "cancelled") {
        throw { code: 409, message: "No se puede editar una tarea cerrada", category: "BUSINESS" };
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, task.restaurant_id as number);
      }

      const updates: Record<string, unknown> = {};
      if (payload.title !== undefined) updates.title = payload.title;
      if (payload.description !== undefined) updates.description = payload.description;
      if (payload.priority !== undefined) updates.priority = payload.priority;
      if (Object.prototype.hasOwnProperty.call(payload, "due_at")) updates.due_at = payload.due_at;
      if (payload.assigned_employee_id !== undefined) {
        await ensureEmployeeUser(payload.assigned_employee_id);
        updates.assigned_employee_id = payload.assigned_employee_id;
      }
      if (payload.requires_evidence !== undefined) updates.requires_evidence = payload.requires_evidence;

      if (Object.keys(updates).length === 0) {
        throw { code: 422, message: "No hay campos para actualizar", category: "VALIDATION" };
      }

      const { error: updateError } = await clientUser.from("operational_tasks").update(updates).eq("id", payload.task_id);
      if (updateError) {
        throw { code: 409, message: "No se pudo actualizar tarea operativa", category: "BUSINESS", details: updateError };
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "OPERATIONAL_TASK_UPDATE",
        context: {
          task_id: payload.task_id,
          fields: Object.keys(updates),
        },
        request_id,
      });

      const successPayload = { success: true, data: { task_id: payload.task_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "cancel") {
      roleGuard(user, ["supervisora", "super_admin"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, restaurant_id, status")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      if (task.status === "completed") {
        throw { code: 409, message: "No se puede cancelar una tarea completada", category: "BUSINESS" };
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, task.restaurant_id as number);
      }

      if (task.status !== "cancelled") {
        const { error: cancelError } = await clientUser
          .from("operational_tasks")
          .update({
            status: "cancelled",
            resolved_at: new Date().toISOString(),
            resolved_by: user.id,
          })
          .eq("id", payload.task_id);

        if (cancelError) {
          throw { code: 409, message: "No se pudo cancelar tarea operativa", category: "BUSINESS", details: cancelError };
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "OPERATIONAL_TASK_CANCEL",
        context: {
          task_id: payload.task_id,
          reason: payload.reason ?? null,
        },
        request_id,
      });

      const successPayload = { success: true, data: { task_id: payload.task_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "mark_in_progress") {
      roleGuard(user, ["empleado", "supervisora", "super_admin"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, restaurant_id, assigned_employee_id, task_scope, status")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      if (task.status === "completed" || task.status === "cancelled") {
        throw { code: 409, message: "No se puede iniciar una tarea cerrada", category: "BUSINESS" };
      }

      if (user.role === "empleado") {
        if (task.task_scope === "restaurant") {
          await ensureEmployeeRestaurantAccess(user.id, task.restaurant_id as number);
          await ensureActiveShiftAtRestaurant(user.id, task.restaurant_id as number);
        } else if (String(task.assigned_employee_id) !== user.id) {
          throw { code: 403, message: "Solo el empleado asignado puede iniciar la tarea", category: "PERMISSION" };
        }
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, task.restaurant_id as number);
      }

      if (task.status !== "in_progress") {
        const { error: updateError } = await clientUser
          .from("operational_tasks")
          .update({ status: "in_progress" })
          .eq("id", payload.task_id);

        if (updateError) {
          throw { code: 409, message: "No se pudo marcar la tarea en progreso", category: "BUSINESS", details: updateError };
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "OPERATIONAL_TASK_MARK_IN_PROGRESS",
        context: { task_id: payload.task_id },
        request_id,
      });

      const successPayload = { success: true, data: { task_id: payload.task_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "close") {
      roleGuard(user, ["supervisora", "super_admin", "empleado"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, restaurant_id, status, assigned_employee_id, task_scope, requires_evidence")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      if (task.status === "completed") {
        throw { code: 409, message: "No se puede cerrar una tarea completada", category: "BUSINESS" };
      }
      if (task.status === "cancelled") {
        throw { code: 409, message: "No se puede cerrar una tarea cancelada", category: "BUSINESS" };
      }

      if (user.role === "empleado") {
        if (task.task_scope === "restaurant") {
          await ensureEmployeeRestaurantAccess(user.id, task.restaurant_id as number);
          await ensureActiveShiftAtRestaurant(user.id, task.restaurant_id as number);
        } else if (String(task.assigned_employee_id) !== user.id) {
          throw { code: 403, message: "Solo el empleado asignado puede cerrar la tarea", category: "PERMISSION" };
        }
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, task.restaurant_id as number);
      }

      if (task.requires_evidence) {
        throw { code: 422, message: "La tarea requiere evidencia para completarse", category: "VALIDATION" };
      }

      if (settings.tasks.require_special_task_notes && !payload.notes && !payload.reason) {
        throw { code: 422, message: "Debe incluir observaciones para cerrar la tarea", category: "VALIDATION" };
      }

      if (task.status !== "completed") {
        const { error: closeError } = await clientUser
          .from("operational_tasks")
          .update({
            status: "completed",
            resolved_at: new Date().toISOString(),
            resolved_by: user.id,
            resolution_notes: payload.notes ?? payload.reason ?? null,
          })
          .eq("id", payload.task_id);

        if (closeError) {
          throw { code: 409, message: "No se pudo cerrar tarea operativa", category: "BUSINESS", details: closeError };
        }
      }

      await safeWriteAudit({
        user_id: user.id,
        action: "OPERATIONAL_TASK_CLOSE",
        context: { task_id: payload.task_id, reason: payload.reason ?? null, notes: payload.notes ?? null },
        request_id,
      });

      const successPayload = { success: true, data: { task_id: payload.task_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "request_manifest_upload") {
      roleGuard(user, ["empleado", "supervisora", "super_admin"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, assigned_employee_id, task_scope")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      const actorForPath = task.task_scope === "restaurant"
        ? user.id
        : (user.role === "empleado" ? user.id : (task.assigned_employee_id as string));
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

    if (payload.action === "request_evidence_upload") {
      roleGuard(user, ["empleado", "supervisora", "super_admin"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, assigned_employee_id, task_scope")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      const actorForPath = task.task_scope === "restaurant"
        ? user.id
        : (user.role === "empleado" ? user.id : (task.assigned_employee_id as string));
      const extension = mimeToExtension(payload.mime_type);
      const path = `users/${actorForPath}/task-evidence/${payload.task_id}/${request_id}.${extension}`;
      const { data, error } = await clientAdmin.storage.from(evidenceBucket).createSignedUploadUrl(path);
      if (error || !data) {
        throw { code: 500, message: "No se pudo generar URL de carga para evidencia", category: "SYSTEM", details: error };
      }

      const successPayload = {
        success: true,
        data: {
          upload: data,
          bucket: evidenceBucket,
          path,
          allowed_mime: ["image/jpeg", "image/png", "image/webp"],
          max_bytes: 8 * 1024 * 1024,
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "complete") {
      roleGuard(user, ["empleado", "supervisora", "super_admin"]);

      const { data: task, error: taskError } = await clientUser
        .from("operational_tasks")
        .select("id, restaurant_id, assigned_employee_id, task_scope, requires_evidence")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      if (user.role === "empleado") {
        if (task.task_scope === "restaurant") {
          await ensureEmployeeRestaurantAccess(user.id, task.restaurant_id as number);
          await ensureActiveShiftAtRestaurant(user.id, task.restaurant_id as number);
        } else if (String(task.assigned_employee_id) !== user.id) {
          throw { code: 403, message: "Tarea no asignada a este empleado", category: "PERMISSION" };
        }
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, task.restaurant_id as number);
      }

      if (settings.tasks.require_special_task_notes && payload.notes) {
        // ok
      } else if (settings.tasks.require_special_task_notes && !payload.notes) {
        throw { code: 422, message: "Debe incluir observaciones para cerrar la tarea", category: "VALIDATION" };
      }

      const actorId = task.task_scope === "restaurant" ? user.id : (task.assigned_employee_id as string);
      const expectedManifestPrefix = `users/${actorId}/task-manifest/${payload.task_id}/`;
      const expectedEvidencePrefix = `users/${actorId}/task-evidence/${payload.task_id}/`;
      if (!payload.evidence_path.startsWith(expectedManifestPrefix) && !payload.evidence_path.startsWith(expectedEvidencePrefix)) {
        throw { code: 403, message: "Ruta de evidencia invalida para la tarea", category: "PERMISSION" };
      }

      const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(evidenceBucket).download(payload.evidence_path);
      if (downloadError || !fileBlob) {
        throw { code: 422, message: "Evidencia no disponible en storage", category: "VALIDATION", details: downloadError };
      }

      if (fileBlob.size <= 0 || fileBlob.size > 8 * 1024 * 1024) {
        throw { code: 422, message: "Tamano de evidencia invalido", category: "VALIDATION", details: { size: fileBlob.size } };
      }

      const evidenceMimeType = inferMimeType(payload.evidence_path, fileBlob.type);
      const allowedMime = ["application/json", "image/jpeg", "image/png", "image/webp"];
      if (!allowedMime.includes(evidenceMimeType)) {
        throw { code: 422, message: "Mime de evidencia no permitido", category: "VALIDATION", details: { mime_type: evidenceMimeType } };
      }

      if (evidenceMimeType === "application/json") {
        const text = await fileBlob.text();
        try {
          JSON.parse(text);
        } catch {
          throw { code: 422, message: "Manifest JSON invalido", category: "VALIDATION" };
        }
      }

      const evidenceHash = await sha256Hex(fileBlob);

      const nowIso = new Date().toISOString();
      const { error } = await clientUser
        .from("operational_tasks")
        .update({
          status: "completed",
          resolved_at: nowIso,
          resolved_by: user.id,
          evidence_path: payload.evidence_path,
          evidence_hash: evidenceHash,
          evidence_mime_type: evidenceMimeType,
          evidence_size_bytes: fileBlob.size,
          resolution_notes: payload.notes ?? null,
          updated_at: nowIso,
        })
        .eq("id", payload.task_id);

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

      // Get restaurants where the employee works to include restaurant-scoped tasks
      const { data: restaurantLinks } = await clientAdmin
        .from("restaurant_employees")
        .select("restaurant_id")
        .eq("user_id", user.id);

      const employeeRestaurantIds = (restaurantLinks ?? [])
        .map((r) => Number(r.restaurant_id))
        .filter((n) => Number.isFinite(n) && n > 0);

      let query = clientUser
        .from("operational_tasks")
        .select("id, shift_id, scheduled_shift_id, restaurant_id, task_scope, assigned_employee_id, created_by, title, description, priority, status, due_at, resolved_at, resolved_by, requires_evidence, resolution_notes, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, created_at, updated_at")
        .in("status", ["pending", "in_progress"])
        .order("updated_at", { ascending: false })
        .limit(payload.limit);

      if (employeeRestaurantIds.length > 0) {
        query = query.or(
          `assigned_employee_id.eq.${user.id},and(task_scope.eq.restaurant,restaurant_id.in.(${employeeRestaurantIds.join(",")}))`
        );
      } else {
        query = query.eq("assigned_employee_id", user.id);
      }

      if (payload.shift_id) query = query.eq("shift_id", payload.shift_id);

      const { data, error } = await query;
      if (error) {
        throw { code: 409, message: "No se pudo listar tareas abiertas", category: "BUSINESS", details: error };
      }

      const items = (data ?? []).map((row) => ({
        ...row,
        task_id: row.id,
        notes_required: settings.tasks.require_special_task_notes === true,
      }));

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    roleGuard(user, ["supervisora", "super_admin"]);

    let query = clientUser
      .from("operational_tasks")
      .select("id, shift_id, scheduled_shift_id, restaurant_id, task_scope, assigned_employee_id, created_by, title, description, priority, status, due_at, resolved_at, resolved_by, requires_evidence, resolution_notes, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, created_at, updated_at")
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

    const items = (data ?? []).map((row) => ({
      ...row,
      task_id: row.id,
      notes_required: settings.tasks.require_special_task_notes === true,
    }));

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
