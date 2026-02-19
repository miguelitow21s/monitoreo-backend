export type UserRole = "super_admin" | "supervisora" | "empleado";
export type ShiftState = "activo" | "finalizado" | "aprobado" | "rechazado";
export type PhotoType = "inicio" | "fin";

export type InternalUser = {
  id: string;
  role: UserRole;
};

export type ErrorCategory = "AUTH" | "VALIDATION" | "PERMISSION" | "BUSINESS" | "SYSTEM";

export type AppError = {
  code: number;
  message: string;
  category: ErrorCategory;
  details?: unknown;
};

export type ApiError = AppError & {
  request_id: string;
};
