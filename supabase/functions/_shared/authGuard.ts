import { z } from "npm:zod@3.23.8";
import { clientAdmin, createUserClient } from "./supabaseClient.ts";
import type { InternalUser, UserRole } from "./types.ts";

const validRoles: UserRole[] = ["super_admin", "supervisora", "empleado"];

const authHeaderSchema = z.string().min(8);

function readJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);

  try {
    const json = atob(padded);
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function authGuard(req: Request): Promise<{ user: InternalUser; token: string; clientUser: ReturnType<typeof createUserClient> }> {
  const authHeader = req.headers.get("Authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
  const rawAuth = (bearerMatch?.[1] ?? authHeader).trim();

  if (!rawAuth || rawAuth.toLowerCase() === "undefined" || rawAuth.toLowerCase() === "null") {
    throw { code: 401, error_code: "AUTH_MISSING_TOKEN", message: "No autenticado: falta la sesion. Inicia sesion de nuevo", category: "AUTH" };
  }

  const parsed = authHeaderSchema.safeParse(rawAuth);
  if (!parsed.success) throw { code: 401, error_code: "AUTH_MALFORMED_TOKEN", message: "No autenticado: sesion mal formada. Inicia sesion de nuevo", category: "AUTH" };

  const token = parsed.data;
  const claims = readJwtPayload(token);
  if (claims) {
    const role = typeof claims.role === "string" ? claims.role : "";
    const exp = typeof claims.exp === "number" ? claims.exp : null;
    const now = Math.floor(Date.now() / 1000);

    if (role === "anon") {
      throw { code: 401, error_code: "AUTH_ANON_TOKEN", message: "Token anonimo no permitido. Inicia sesion", category: "AUTH" };
    }
    if (exp !== null && exp <= now) {
      throw { code: 401, error_code: "AUTH_SESSION_EXPIRED", message: "Tu sesion expiro. Inicia sesion de nuevo", category: "AUTH" };
    }
  }

  const { data, error } = await clientAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    throw { code: 401, error_code: "AUTH_SESSION_INVALID", message: "Sesion invalida. Inicia sesion de nuevo", category: "AUTH" };
  }

  const { data: dbUser, error: dbError } = await clientAdmin
    .from("users")
    .select("id, is_active, roles(name)")
    .eq("id", data.user.id)
    .single();

  if (dbError || !dbUser?.id) {
    throw { code: 403, error_code: "USER_NO_INTERNAL_PROFILE", message: "Tu usuario no tiene perfil interno. Contacta al administrador", category: "PERMISSION" };
  }

  if (dbUser.is_active === false) {
    throw { code: 403, error_code: "USER_INACTIVE", message: "Tu usuario esta inactivo. Contacta al administrador", category: "PERMISSION" };
  }

  const role = (dbUser.roles as { name?: UserRole } | null)?.name;
  if (!role || !validRoles.includes(role)) {
    throw { code: 403, error_code: "USER_ROLE_INVALID", message: "Tu usuario no tiene un rol valido. Contacta al administrador", category: "PERMISSION" };
  }

  return {
    user: { id: dbUser.id, role },
    token,
    clientUser: createUserClient(token),
  };
}
