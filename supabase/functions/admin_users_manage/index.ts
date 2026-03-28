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

const endpoint = "admin_users_manage";

type AppRole = "super_admin" | "supervisora" | "empleado";
const E164_PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;

const createAction = z.object({
  action: z.literal("create"),
  email: z.string().email(),
  role: z.enum(["super_admin", "supervisora", "empleado"]),
  password: z.string().min(8).max(128).optional(),
  first_name: z.string().trim().min(1).max(120).optional().nullable(),
  last_name: z.string().trim().min(1).max(120).optional().nullable(),
  full_name: z.string().trim().min(1).max(200).optional().nullable(),
  phone_number: z.string().trim().max(30).optional().nullable(),
  is_active: z.boolean().optional(),
});

const updateAction = z.object({
  action: z.literal("update"),
  user_id: z.string().uuid(),
  email: z.string().email().optional(),
  role: z.enum(["super_admin", "supervisora", "empleado"]).optional(),
  first_name: z.string().trim().min(1).max(120).optional().nullable(),
  last_name: z.string().trim().min(1).max(120).optional().nullable(),
  full_name: z.string().trim().min(1).max(200).optional().nullable(),
  phone_number: z.string().trim().max(30).optional().nullable(),
  is_active: z.boolean().optional(),
});

const activateAction = z.object({
  action: z.literal("activate"),
  user_id: z.string().uuid(),
});

const deactivateAction = z.object({
  action: z.literal("deactivate"),
  user_id: z.string().uuid(),
  reason: z.string().trim().max(500).optional().nullable(),
});

const listAction = z.object({
  action: z.literal("list"),
  role: z.enum(["super_admin", "supervisora", "empleado"]).optional(),
  is_active: z.boolean().optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const payloadSchema = z.discriminatedUnion("action", [
  createAction,
  updateAction,
  activateAction,
  deactivateAction,
  listAction,
]);

function randomPassword() {
  const randomPart = crypto.randomUUID().replaceAll("-", "");
  return `Tmp#${randomPart.slice(0, 20)}A1`;
}

function normalizePhoneNumber(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function assertRolePhoneRequirement(role: AppRole, phoneNumber: string | null) {
  if (phoneNumber && !E164_PHONE_REGEX.test(phoneNumber)) {
    throw {
      code: 422,
      message: "Celular invalido. Use formato E.164 (+573001112233)",
      category: "VALIDATION",
    };
  }

  if ((role === "empleado" || role === "supervisora") && !phoneNumber) {
    throw {
      code: 422,
      message: "Celular es obligatorio para empleado y supervisora. Use formato E.164 (+573001112233)",
      category: "VALIDATION",
    };
  }
}

async function getRoleIdMap() {
  const { data, error } = await clientAdmin.from("roles").select("id, name").in("name", ["super_admin", "supervisora", "empleado"]);
  if (error || !data) {
    throw { code: 500, message: "No se pudieron cargar roles", category: "SYSTEM", details: error };
  }

  const map = new Map<string, number>();
  for (const row of data) {
    map.set(String(row.name), Number(row.id));
  }

  for (const role of ["super_admin", "supervisora", "empleado"]) {
    if (!map.has(role)) {
      throw { code: 500, message: `Rol requerido no encontrado: ${role}`, category: "SYSTEM" };
    }
  }

  return map;
}

async function getUserProfile(userId: string) {
  const { data, error } = await clientAdmin
    .from("profiles")
    .select("id, first_name, last_name, full_name, email, phone_number, role, is_active")
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw { code: 404, message: "Usuario no encontrado", category: "BUSINESS", details: error };
  }

  return data;
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
  let userRole: AppRole | undefined;
  let idempotencyKey: string | null = null;

  try {
    requireMethod(req, ["POST"]);
    const { user } = await authGuard(req);
    userId = user.id;
    userRole = user.role;
    await requireAcceptedActiveLegalTerm(user.id);

    const parsedPayload = await parseBody(req, payloadSchema);
    const payload = parsedPayload as z.infer<typeof payloadSchema>;
    if (payload.action === "create") {
      roleGuard(user, ["super_admin", "supervisora"]);
      if (user.role === "supervisora" && payload.role !== "empleado") {
        throw {
          code: 403,
          message: "Supervisora solo puede crear empleados",
          category: "PERMISSION",
        };
      }
    } else {
      roleGuard(user, ["super_admin"]);
    }
    idempotencyKey = requireIdempotencyKey(req);

    const payloadHash = await hashCanonicalJson(payload);
    const claim = await claimIdempotency({ userId: user.id, endpoint, key: idempotencyKey, payloadHash });
    if (claim.type === "replay") {
      status = claim.stored.status_code;
      return replayIdempotentResponse(claim.stored, request_id);
    }

    await rateLimiter({ user_id: user.id, ip, endpoint, limit: 30, window_seconds: 60 });

    if (payload.action === "create") {
      const settings = await getSystemSettings(clientAdmin);
      const roleIdMap = await getRoleIdMap();
      const roleId = roleIdMap.get(payload.role);
      if (!roleId) {
        throw { code: 422, message: "Rol invalido", category: "VALIDATION" };
      }

      const firstName = payload.first_name?.trim() || null;
      const lastName = payload.last_name?.trim() || null;
      const fullName = payload.full_name?.trim() || [firstName, lastName].filter(Boolean).join(" ") || null;
      const phoneNumber = normalizePhoneNumber(payload.phone_number);
      assertRolePhoneRequirement(payload.role, phoneNumber);
      const isActive = payload.is_active ?? true;
      const mustChangePin = settings.security.force_password_change_on_first_login === true;

      const { data: createdAuth, error: createAuthError } = await clientAdmin.auth.admin.createUser({
        email: payload.email,
        password: payload.password ?? randomPassword(),
        email_confirm: true,
        user_metadata: {
          first_name: firstName,
          last_name: lastName,
          full_name: fullName,
          phone_number: phoneNumber,
        },
      });

      if (createAuthError || !createdAuth?.user?.id) {
        throw { code: 409, message: "No se pudo crear usuario en Auth", category: "BUSINESS", details: createAuthError };
      }

      const newUserId = createdAuth.user.id;

      const { error: upsertError } = await clientAdmin.from("users").upsert(
        {
          id: newUserId,
          email: payload.email,
          role_id: roleId,
          first_name: firstName,
          last_name: lastName,
          full_name: fullName,
          phone_e164: phoneNumber,
          is_active: isActive,
          must_change_pin: mustChangePin,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" }
      );

      if (upsertError) {
        throw { code: 409, message: "No se pudo crear perfil interno de usuario", category: "BUSINESS", details: upsertError };
      }

      if (!isActive) {
        const { error: blockError } = await clientAdmin.auth.admin.updateUserById(newUserId, { ban_duration: "876000h" });
        if (blockError) {
          throw { code: 409, message: "No se pudo desactivar acceso Auth del usuario", category: "BUSINESS", details: blockError };
        }
      }

      const createdProfile = await getUserProfile(newUserId);

      await safeWriteAudit({
        user_id: user.id,
        action: "ADMIN_USER_CREATE",
        context: { target_user_id: newUserId, email: payload.email, role: payload.role, is_active: isActive },
        request_id,
      });

      const successPayload = { success: true, data: { user: createdProfile }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "update") {
      const currentProfile = await getUserProfile(payload.user_id);
      const targetRole = String(payload.role ?? currentProfile.role) as AppRole;
      const targetPhone = payload.phone_number !== undefined
        ? normalizePhoneNumber(payload.phone_number)
        : normalizePhoneNumber(currentProfile.phone_number as string | null | undefined);
      assertRolePhoneRequirement(targetRole, targetPhone);

      const roleIdMap = await getRoleIdMap();
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

      if (payload.role) {
        const roleId = roleIdMap.get(payload.role);
        if (!roleId) {
          throw { code: 422, message: "Rol invalido", category: "VALIDATION" };
        }
        patch.role_id = roleId;
      }

      if (payload.first_name !== undefined) patch.first_name = payload.first_name?.trim() || null;
      if (payload.last_name !== undefined) patch.last_name = payload.last_name?.trim() || null;
      if (payload.full_name !== undefined) patch.full_name = payload.full_name?.trim() || null;
      if (payload.phone_number !== undefined) patch.phone_e164 = payload.phone_number?.trim() || null;
      if (payload.is_active !== undefined) patch.is_active = payload.is_active;
      if (payload.email !== undefined) patch.email = payload.email;

      const { error: updateError } = await clientAdmin.from("users").update(patch).eq("id", payload.user_id);
      if (updateError) {
        throw { code: 409, message: "No se pudo actualizar usuario", category: "BUSINESS", details: updateError };
      }

      if (payload.email !== undefined || payload.is_active !== undefined) {
        const authPatch: Record<string, unknown> = {};
        if (payload.email !== undefined) authPatch.email = payload.email;
        if (payload.is_active === false) authPatch.ban_duration = "876000h";
        if (payload.is_active === true) authPatch.ban_duration = "none";

        const { error: authUpdateError } = await clientAdmin.auth.admin.updateUserById(payload.user_id, authPatch);
        if (authUpdateError) {
          throw { code: 409, message: "No se pudo sincronizar usuario en Auth", category: "BUSINESS", details: authUpdateError };
        }
      }

      const updatedProfile = await getUserProfile(payload.user_id);

      await safeWriteAudit({
        user_id: user.id,
        action: "ADMIN_USER_UPDATE",
        context: { target_user_id: payload.user_id, fields: Object.keys(patch) },
        request_id,
      });

      const successPayload = { success: true, data: { user: updatedProfile }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    if (payload.action === "activate" || payload.action === "deactivate") {
      const isActive = payload.action === "activate";
      const { error: patchError } = await clientAdmin
        .from("users")
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq("id", payload.user_id);

      if (patchError) {
        throw { code: 409, message: "No se pudo actualizar estado de usuario", category: "BUSINESS", details: patchError };
      }

      const { error: authUpdateError } = await clientAdmin.auth.admin.updateUserById(payload.user_id, {
        ban_duration: isActive ? "none" : "876000h",
      });
      if (authUpdateError) {
        throw { code: 409, message: "No se pudo sincronizar estado en Auth", category: "BUSINESS", details: authUpdateError };
      }

      const profile = await getUserProfile(payload.user_id);

      await safeWriteAudit({
        user_id: user.id,
        action: isActive ? "ADMIN_USER_ACTIVATE" : "ADMIN_USER_DEACTIVATE",
        context: {
          target_user_id: payload.user_id,
          reason: payload.action === "deactivate" ? payload.reason ?? null : null,
        },
        request_id,
      });

      const successPayload = { success: true, data: { user: profile }, error: null, request_id };
      await safeFinalizeIdempotency({ userId: user.id, endpoint, key: idempotencyKey, statusCode: 200, responseBody: successPayload });
      return response(true, successPayload.data, null, request_id);
    }

    let query = clientAdmin
      .from("profiles")
      .select("id, first_name, last_name, full_name, email, phone_number, role, is_active")
      .order("email", { ascending: true });

    if (payload.role) query = query.eq("role", payload.role);
    if (payload.is_active !== undefined) query = query.eq("is_active", payload.is_active);

    const searchRaw = payload.search?.trim();
    if (searchRaw) {
      const term = searchRaw.replace(/,/g, " ");
      query = query.or(
        `email.ilike.%${term}%,full_name.ilike.%${term}%,first_name.ilike.%${term}%,last_name.ilike.%${term}%`
      );
    }

    query = query.limit(payload.limit);

    const { data, error } = await query;
    if (error) {
      throw { code: 409, message: "No se pudo listar usuarios", category: "BUSINESS", details: error };
    }

    const items = (data ?? []) as Array<Record<string, unknown>>;

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
