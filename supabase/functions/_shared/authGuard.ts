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
    throw { code: 401, message: "No autenticado", category: "AUTH" };
  }

  const parsed = authHeaderSchema.safeParse(rawAuth);
  if (!parsed.success) throw { code: 401, message: "No autenticado", category: "AUTH" };

  const token = parsed.data;
  const claims = readJwtPayload(token);
  if (claims) {
    const role = typeof claims.role === "string" ? claims.role : "";
    const exp = typeof claims.exp === "number" ? claims.exp : null;
    const now = Math.floor(Date.now() / 1000);

    if (role === "anon") {
      throw { code: 401, message: "Token anon no permitido", category: "AUTH" };
    }
    if (exp !== null && exp <= now) {
      throw { code: 401, message: "Sesion expirada", category: "AUTH" };
    }
  }

  const { data, error } = await clientAdmin.auth.getUser(token);
  if (error || !data?.user?.id) {
    throw { code: 401, message: "Sesion invalida", category: "AUTH" };
  }

  const { data: dbUser, error: dbError } = await clientAdmin
    .from("users")
    .select("id, roles(name)")
    .eq("id", data.user.id)
    .single();

  if (dbError || !dbUser?.id) {
    throw { code: 403, message: "Usuario sin perfil interno", category: "PERMISSION" };
  }

  const role = (dbUser.roles as { name?: UserRole } | null)?.name;
  if (!role || !validRoles.includes(role)) {
    throw { code: 403, message: "Rol invalido", category: "PERMISSION" };
  }

  return {
    user: { id: dbUser.id, role },
    token,
    clientUser: createUserClient(token),
  };
}
