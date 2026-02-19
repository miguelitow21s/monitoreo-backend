import { z } from "npm:zod@3.23.8";
import { clientAdmin, createUserClient } from "./supabaseClient.ts";
import type { InternalUser, UserRole } from "./types.ts";

const validRoles: UserRole[] = ["super_admin", "supervisora", "empleado"];

const authHeaderSchema = z.string().min(8);

export async function authGuard(req: Request): Promise<{ user: InternalUser; token: string; clientUser: ReturnType<typeof createUserClient> }> {
  const rawAuth = req.headers.get("Authorization")?.replace("Bearer ", "").trim() ?? "";
  const parsed = authHeaderSchema.safeParse(rawAuth);
  if (!parsed.success) throw { code: 401, message: "No autenticado", category: "AUTH" };

  const token = parsed.data;
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
