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
import { notifyOperationalTaskCompleted, safeDispatchPendingEmailNotifications } from "../_shared/emailNotifications.ts";
import { runInBackground } from "../_shared/background.ts";

const endpoint = "operational_tasks_manage";
const evidenceBucket = "shift-evidence";
const allowedImageMimeValues = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;
const allowedVideoMimeValues = ["video/mp4", "video/quicktime", "video/webm"] as const;
const allowedEvidenceMimeValues = [...allowedImageMimeValues, ...allowedVideoMimeValues] as const;
const evidenceMimeSchema = z.enum(allowedEvidenceMimeValues);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB

function isVideoMime(mime: string): boolean {
  return (allowedVideoMimeValues as readonly string[]).includes(mime);
}
function isImageMime(mime: string): boolean {
  return (allowedImageMimeValues as readonly string[]).includes(mime);
}
// Which mimes are acceptable as CONTRACTOR EVIDENCE for a task.
// Since #9 the contractor may answer with photos AND/OR videos, so both are
// accepted regardless of the task's evidence_type hint (migration 057 enabled
// video mimes on the CHECK constraint and the guard trigger).
function allowedMimesForEvidenceType(_evidenceType: string): string[] {
  return [...allowedEvidenceMimeValues];
}

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
  evidence_type: z.enum(["photo", "video", "any"]).optional(),
  instructions_video_path: z.string().trim().max(500).optional().nullable(),
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
  mime_type: evidenceMimeSchema.default("image/jpeg"),
  // Hint from the app for the file being uploaded (#9). Photos and videos are
  // both accepted; this is informational and echoed back in the response.
  evidence_type: z.enum(["photo", "video"]).optional(),
});

// Inspector uploads an instructions video BEFORE the task exists (no task_id).
const requestInstructionsUploadAction = z.object({
  action: z.literal("request_instructions_upload"),
  restaurant_id: z.number().int().positive(),
  content_type: z.enum(allowedVideoMimeValues).default("video/mp4"),
  filename: z.string().trim().max(200).optional(),
});

const completeAction = z.object({
  action: z.literal("complete"),
  task_id: z.number().int().positive(),
  // evidence_paths[] is the source of truth (#9: multiple photos/videos);
  // evidence_path stays accepted for older builds.
  evidence_path: z.string().min(20).max(500).optional(),
  evidence_paths: z.array(z.string().min(20).max(500)).min(1).max(20).optional(),
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
  requestInstructionsUploadAction,
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
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "image/heif") return "heif";
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/webm") return "webm";
  return "json";
}

function inferMimeType(path: string, blobType: string) {
  const byBlob = (blobType || "").toLowerCase();
  if (byBlob) return byBlob;

  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
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

  if (link) {
    return;
  }

  const { data: scheduledShift } = await clientAdmin
    .from("scheduled_shifts")
    .select("id")
    .eq("employee_id", employeeId)
    .eq("restaurant_id", restaurantId)
    .in("status", ["scheduled", "started"])
    .gte("scheduled_end", new Date().toISOString())
    .limit(1)
    .maybeSingle();

  if (scheduledShift) {
    return;
  }

  const { data: activeShift } = await clientAdmin
    .from("shifts")
    .select("id")
    .eq("employee_id", employeeId)
    .eq("restaurant_id", restaurantId)
    .eq("state", "activo")
    .limit(1)
    .maybeSingle();

  if (activeShift) {
    return;
  }

  throw {
    code: 403,
    message: "No tienes acceso a tareas de este restaurante",
    category: "PERMISSION",
    details: { diagnostic_code: "RESTAURANT_FORBIDDEN" },
  };
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

      // Guard the instructions video path so a task can't be pointed at an
      // arbitrary storage object; it must have the exact shape produced by
      // request_instructions_upload and (for restaurant scope) match the
      // restaurant it's being attached to (audit B2).
      if (payload.instructions_video_path) {
        const ivp = payload.instructions_video_path;
        const m = /^task-instructions\/(\d+)\/[0-9a-fA-F-]{36}\.(mp4|mov|webm)$/.exec(ivp);
        if (!m || (payload.restaurant_id && Number(m[1]) !== Number(payload.restaurant_id))) {
          throw {
            code: 422,
            error_code: "INSTRUCTIONS_VIDEO_PATH_INVALID",
            message: "Ruta de video de instrucciones invalida",
            category: "VALIDATION",
            details: { instructions_video_path: ivp },
          };
        }
      }

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
            evidence_type: payload.evidence_type ?? "photo",
            instructions_video_path: payload.instructions_video_path ?? null,
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
            evidence_type: payload.evidence_type ?? "photo",
            instructions_video_path: payload.instructions_video_path ?? null,
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
        // Site-task model: any contractor with an active visit at the site can
        // operate it -- presence, not assignment.
        await ensureActiveShiftAtRestaurant(user.id, task.restaurant_id as number);
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
        // Site-task model: any contractor with an active visit at the site can
        // operate it -- presence, not assignment.
        await ensureActiveShiftAtRestaurant(user.id, task.restaurant_id as number);
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
        .select("id, assigned_employee_id, task_scope, evidence_type")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      const evidenceType = String(task.evidence_type ?? "photo");
      const allowedForTask = allowedMimesForEvidenceType(evidenceType);
      if (!allowedForTask.includes(payload.mime_type)) {
        throw {
          code: 422,
          error_code: "EVIDENCE_MIME_NOT_ALLOWED_FOR_TASK",
          message: evidenceType === "video"
            ? "Esta tarea requiere un video como evidencia"
            : evidenceType === "photo"
              ? "Esta tarea requiere una foto como evidencia"
              : "Tipo de evidencia no permitido para esta tarea",
          category: "VALIDATION",
          details: { evidence_type: evidenceType, requested_mime: payload.mime_type, allowed_mime: allowedForTask },
        };
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
          evidence_type: evidenceType,
          allowed_mime: allowedForTask,
          max_bytes: isVideoMime(payload.mime_type) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES,
        },
        error: null,
        request_id,
      };

      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "request_instructions_upload") {
      roleGuard(user, ["supervisora", "super_admin"]);

      const { data: restaurant, error: restaurantError } = await clientAdmin
        .from("restaurants")
        .select("id")
        .eq("id", payload.restaurant_id)
        .maybeSingle();

      if (restaurantError || !restaurant) {
        throw {
          code: 404,
          error_code: "RESTAURANT_NOT_FOUND",
          message: "Restaurante no encontrado",
          category: "BUSINESS",
          details: { restaurant_id: payload.restaurant_id },
        };
      }

      if (user.role === "supervisora") {
        await ensureSupervisorRestaurantAccess(user.id, payload.restaurant_id);
      }

      const extension = mimeToExtension(payload.content_type);
      const path = `task-instructions/${payload.restaurant_id}/${request_id}.${extension}`;
      const { data, error } = await clientAdmin.storage.from(evidenceBucket).createSignedUploadUrl(path);
      if (error || !data) {
        throw { code: 500, message: "No se pudo generar URL de carga para video de instrucciones", category: "SYSTEM", details: error };
      }

      const successPayload = {
        success: true,
        data: {
          signedUrl: data.signedUrl,
          token: data.token,
          path,
          upload: data,
          bucket: evidenceBucket,
          content_type: payload.content_type,
          allowed_mime: [...allowedVideoMimeValues],
          max_bytes: MAX_VIDEO_BYTES,
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
        .select("id, restaurant_id, assigned_employee_id, task_scope, requires_evidence, evidence_type, status, created_by, title")
        .eq("id", payload.task_id)
        .single();

      if (taskError || !task) {
        throw { code: 404, message: "Tarea operativa no encontrada", category: "BUSINESS", details: taskError };
      }

      // Don't let a cancelled/completed task be (re)completed (audit M2): other
      // actions already guard this, complete did not.
      if (task.status === "completed" || task.status === "cancelled") {
        throw {
          code: 409,
          error_code: task.status === "completed" ? "TASK_ALREADY_COMPLETED" : "TASK_CANCELLED",
          message: task.status === "completed" ? "La tarea ya fue completada" : "La tarea fue cancelada",
          category: "BUSINESS",
          details: { current_status: task.status },
        };
      }

      if (user.role === "empleado") {
        // Site-task model: any contractor physically on site (active visit) can
        // close the task, regardless of who -- if anyone -- it was assigned to.
        // The active visit is the presence proof; no restaurant_staff assignment
        // is required anymore.
        await ensureActiveShiftAtRestaurant(user.id, task.restaurant_id as number);
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
      // #9: the contractor can attach several photos and/or videos.
      // evidence_paths[] is the source of truth; evidence_path is the legacy single.
      const evidencePaths = payload.evidence_paths?.length
        ? payload.evidence_paths
        : payload.evidence_path
          ? [payload.evidence_path]
          : [];

      if (evidencePaths.length === 0) {
        throw {
          code: 422,
          error_code: "EVIDENCE_REQUIRED",
          message: "Debes adjuntar al menos una evidencia",
          category: "VALIDATION",
        };
      }

      const allowedMime = ["application/json", ...allowedEvidenceMimeValues];
      const evidenceItems: Array<{ path: string; hash: string; mime_type: string; size_bytes: number }> = [];

      for (const path of evidencePaths) {
        if (!path.startsWith(expectedManifestPrefix) && !path.startsWith(expectedEvidencePrefix)) {
          throw { code: 403, error_code: "EVIDENCE_PATH_INVALID", message: "Ruta de evidencia invalida para la tarea", category: "PERMISSION", details: { path } };
        }

        const { data: fileBlob, error: downloadError } = await clientAdmin.storage.from(evidenceBucket).download(path);
        if (downloadError || !fileBlob) {
          throw { code: 422, error_code: "EVIDENCE_NOT_FOUND", message: "Evidencia no disponible en storage", category: "VALIDATION", details: { path, error: downloadError } };
        }

        const mimeType = inferMimeType(path, fileBlob.type);
        if (!allowedMime.includes(mimeType)) {
          throw { code: 422, error_code: "EVIDENCE_MIME_NOT_ALLOWED", message: "Mime de evidencia no permitido", category: "VALIDATION", details: { path, mime_type: mimeType } };
        }

        // Videos are allowed to be larger than photos.
        const maxBytes = isVideoMime(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (fileBlob.size <= 0 || fileBlob.size > maxBytes) {
          throw { code: 422, error_code: "EVIDENCE_SIZE_INVALID", message: "Tamano de evidencia invalido", category: "VALIDATION", details: { path, size: fileBlob.size, max_bytes: maxBytes } };
        }

        if (mimeType === "application/json") {
          const text = await fileBlob.text();
          try {
            JSON.parse(text);
          } catch {
            throw { code: 422, error_code: "MANIFEST_INVALID", message: "Manifest JSON invalido", category: "VALIDATION", details: { path } };
          }
        }

        evidenceItems.push({ path, hash: await sha256Hex(fileBlob), mime_type: mimeType, size_bytes: fileBlob.size });
      }

      // Legacy single columns mirror the first item (the guard trigger requires them).
      const primaryEvidence = evidenceItems[0];
      const nowIso = new Date().toISOString();
      const { error } = await clientUser
        .from("operational_tasks")
        .update({
          status: "completed",
          resolved_at: nowIso,
          resolved_by: user.id,
          evidence_path: primaryEvidence.path,
          evidence_hash: primaryEvidence.hash,
          evidence_mime_type: primaryEvidence.mime_type,
          evidence_size_bytes: primaryEvidence.size_bytes,
          evidence_items: evidenceItems,
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
          evidence_count: evidenceItems.length,
          evidence_paths: evidenceItems.map((e) => e.path),
          evidence_hashes: evidenceItems.map((e) => e.hash),
          evidence_total_bytes: evidenceItems.reduce((acc, e) => acc + e.size_bytes, 0),
        },
        request_id,
      });

      // Tell the task's creator and the site's supervisors it's done -- off the
      // critical path so a notification hiccup never blocks the completion. JSON
      // manifests aren't viewable, so only photo/video evidence is linked.
      runInBackground(
        (async () => {
          await notifyOperationalTaskCompleted({
            taskId: Number(payload.task_id),
            restaurantId: Number(task.restaurant_id),
            title: (task.title as string | null) ?? null,
            createdBy: String(task.created_by),
            resolvedBy: user.id,
            notes: payload.notes ?? null,
            resolvedAt: nowIso,
            evidencePaths: evidenceItems.filter((e) => e.mime_type !== "application/json").map((e) => e.path),
          });
          await safeDispatchPendingEmailNotifications({ limit: 25, maxAttempts: 5 });
        })()
      );

      const successPayload = { success: true, data: { task_id: payload.task_id }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "list_my_open") {
      roleGuard(user, ["empleado"]);

      // Site-task model (visit migration): a "restaurant" task belongs to the SITE,
      // not to a contractor. Anyone with an ACTIVE VISIT at that site sees it --
      // that visit (geofence-backed) is the presence proof, so no restaurant_staff
      // assignment is required. `assigned_employee_id` no longer gates visibility;
      // it stays only so legacy per-employee tasks still reach their assignee.
      const { data: activeShiftRows } = await clientAdmin
        .from("shifts")
        .select("restaurant_id")
        .eq("employee_id", user.id)
        .eq("state", "activo");

      const activeVisitRestaurantIds = [
        ...new Set(
          (activeShiftRows ?? [])
            .map((row) => Number(row.restaurant_id))
            .filter((n) => Number.isFinite(n) && n > 0)
        ),
      ];

      let query = clientUser
        .from("operational_tasks")
        .select("id, shift_id, scheduled_shift_id, restaurant_id, task_scope, assigned_employee_id, created_by, title, description, priority, status, due_at, resolved_at, resolved_by, requires_evidence, evidence_type, instructions_video_path, resolution_notes, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, evidence_items, created_at, updated_at")
        .in("status", ["pending", "in_progress"])
        .order("updated_at", { ascending: false })
        .limit(payload.limit);

      if (activeVisitRestaurantIds.length > 0) {
        query = query.or(
          `assigned_employee_id.eq.${user.id},and(task_scope.eq.restaurant,restaurant_id.in.(${activeVisitRestaurantIds.join(",")}))`
        );
      } else {
        query = query.eq("assigned_employee_id", user.id);
      }

      if (payload.shift_id) query = query.eq("shift_id", payload.shift_id);

      const { data, error } = await query;
      if (error) {
        throw { code: 409, message: "No se pudo listar tareas abiertas", category: "BUSINESS", details: error };
      }

      // Sign the instructions video AND every evidence file in a single batch:
      // one instructions video per task (inspector -> contractor) plus the
      // contractor's photos/videos (#9).
      const rows = data ?? [];
      const collectEvidencePaths = (row: Record<string, unknown>): string[] => {
        const items = Array.isArray(row.evidence_items) ? row.evidence_items : null;
        if (items && items.length > 0) {
          return items
            .map((it) => (it as { path?: string } | null)?.path)
            .filter((p): p is string => typeof p === "string" && p.length > 0);
        }
        return typeof row.evidence_path === "string" && row.evidence_path.length > 0 ? [row.evidence_path] : [];
      };

      const allPaths = [
        ...new Set([
          ...rows.map((r) => r.instructions_video_path).filter((p) => typeof p === "string" && p.length > 0),
          ...rows.flatMap((r) => collectEvidencePaths(r as Record<string, unknown>)),
        ]),
      ] as string[];

      const signedByPath = new Map<string, string>();
      if (allPaths.length > 0) {
        const { data: signed } = await clientAdmin.storage.from(evidenceBucket).createSignedUrls(allPaths, 7200);
        (signed ?? []).forEach((s, i) => {
          if (s && s.signedUrl && !s.error) signedByPath.set(allPaths[i], s.signedUrl);
        });
      }

      const items = rows.map((row) => {
        const evidencePathList = collectEvidencePaths(row as Record<string, unknown>);
        return {
          ...row,
          task_id: row.id,
          instructions_video_url: row.instructions_video_path ? (signedByPath.get(row.instructions_video_path) ?? null) : null,
          evidence_urls: evidencePathList
            .map((p) => signedByPath.get(p))
            .filter((u): u is string => typeof u === "string"),
          notes_required: settings.tasks.require_special_task_notes === true,
        };
      });

      const successPayload = { success: true, data: { items }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    roleGuard(user, ["supervisora", "super_admin"]);

    let query = clientUser
      .from("operational_tasks")
      .select("id, shift_id, scheduled_shift_id, restaurant_id, task_scope, assigned_employee_id, created_by, title, description, priority, status, due_at, resolved_at, resolved_by, requires_evidence, evidence_type, instructions_video_path, resolution_notes, evidence_path, evidence_hash, evidence_mime_type, evidence_size_bytes, evidence_items, created_at, updated_at")
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
