import type { InternalUser, UserRole } from "./types.ts";

export function roleGuard(user: InternalUser, allowedRoles: UserRole[]) {
  if (!allowedRoles.includes(user.role)) {
    throw {
      code: 403,
      error_code: "ROLE_NOT_ALLOWED",
      message: "Tu rol no tiene permiso para esta operacion",
      category: "PERMISSION",
      details: { your_role: user.role, allowed_roles: allowedRoles },
    };
  }
}
