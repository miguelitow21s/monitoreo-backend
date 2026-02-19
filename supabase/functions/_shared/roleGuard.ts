import type { InternalUser, UserRole } from "./types.ts";

export function roleGuard(user: InternalUser, allowedRoles: UserRole[]) {
  if (!allowedRoles.includes(user.role)) {
    throw { code: 403, message: "Sin permisos para esta operacion", category: "PERMISSION" };
  }
}
