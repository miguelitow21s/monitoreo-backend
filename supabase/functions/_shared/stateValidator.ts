import type { PhotoType, ShiftState } from "./types.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function ensureNoActiveShift(client: SupabaseClient, user_id: string) {
  const { count, error } = await client
    .from("shifts")
    .select("id", { count: "exact", head: true })
    .eq("employee_id", user_id)
    .eq("state", "activo");

  if (error) throw { code: 500, message: "No se pudo validar estado", category: "SYSTEM", details: error };
  if ((count ?? 0) > 0) throw { code: 409, message: "Ya existe un turno activo", category: "BUSINESS" };
}

export async function getOwnedShift(client: SupabaseClient, user_id: string, shift_id: number) {
  const { data, error } = await client
    .from("shifts")
    .select("id, employee_id, restaurant_id, state")
    .eq("id", shift_id)
    .eq("employee_id", user_id)
    .single();

  if (error || !data) {
    throw { code: 403, message: "Turno no pertenece al usuario", category: "PERMISSION" };
  }

  return data as { id: number; employee_id: string; restaurant_id: number; state: ShiftState };
}

export function ensureShiftState(shiftState: ShiftState, allowed: ShiftState[], message: string) {
  if (!allowed.includes(shiftState)) {
    throw { code: 409, message, category: "BUSINESS" };
  }
}

export async function ensureEvidenceNotDuplicate(client: SupabaseClient, shift_id: number, type: PhotoType) {
  const { count, error } = await client
    .from("shift_photos")
    .select("id", { count: "exact", head: true })
    .eq("shift_id", shift_id)
    .eq("type", type);

  if (error) throw { code: 500, message: "No se pudo validar evidencia", category: "SYSTEM", details: error };
  if ((count ?? 0) > 0) throw { code: 409, message: "Evidencia duplicada", category: "BUSINESS" };
}

export async function ensureShiftFinalized(client: SupabaseClient, shift_id: number) {
  const { data, error } = await client.from("shifts").select("id, state").eq("id", shift_id).single();
  if (error || !data) throw { code: 404, message: "Turno no encontrado", category: "BUSINESS" };
  if (data.state !== "finalizado") {
    throw {
      code: 409,
      message: "Solo turnos finalizados pueden aprobarse o rechazarse",
      category: "BUSINESS",
    };
  }
}
