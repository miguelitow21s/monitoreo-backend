import type { PhotoType, ShiftState } from "./types.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function ensureNoActiveShift(client: SupabaseClient, user_id: string) {
  const { count, error } = await client
    .from("shifts")
    .select("id", { count: "exact", head: true })
    .eq("employee_id", user_id)
    .eq("state", "activo");

  if (error) throw { code: 500, error_code: "ACTIVE_SHIFT_CHECK_FAILED", message: "No se pudo validar estado del servicio", category: "SYSTEM", details: error };
  if ((count ?? 0) > 0) throw { code: 409, error_code: "SHIFT_ALREADY_ACTIVE", message: "Ya tienes un servicio activo. Finalizalo antes de iniciar otro", category: "BUSINESS" };
}

export async function getOwnedShift(client: SupabaseClient, user_id: string, shift_id: number) {
  const { data, error } = await client
    .from("shifts")
    .select("id, employee_id, restaurant_id, state, start_time")
    .eq("id", shift_id)
    .eq("employee_id", user_id)
    .single();

  if (error || !data) {
    throw { code: 403, error_code: "SHIFT_NOT_OWNED", message: "Este servicio no pertenece a tu usuario", category: "PERMISSION", details: { shift_id } };
  }

  return data as { id: number; employee_id: string; restaurant_id: number; state: ShiftState; start_time: string };
}

export function ensureShiftState(shiftState: ShiftState, allowed: ShiftState[], message: string, errorCode = "SHIFT_STATE_INVALID") {
  if (!allowed.includes(shiftState)) {
    throw { code: 409, error_code: errorCode, message, category: "BUSINESS", details: { current_state: shiftState, allowed_states: allowed } };
  }
}

export async function ensureEvidenceNotDuplicate(client: SupabaseClient, shift_id: number, type: PhotoType) {
  const { count, error } = await client
    .from("shift_photos")
    .select("id", { count: "exact", head: true })
    .eq("shift_id", shift_id)
    .eq("type", type);

  if (error) throw { code: 500, error_code: "EVIDENCE_CHECK_FAILED", message: "No se pudo validar evidencia", category: "SYSTEM", details: error };
  if ((count ?? 0) > 0) throw { code: 409, error_code: "EVIDENCE_DUPLICATE", message: "Ya existe evidencia de este tipo para el servicio", category: "BUSINESS" };
}

export async function ensureShiftFinalized(client: SupabaseClient, shift_id: number) {
  const { data, error } = await client.from("shifts").select("id, state").eq("id", shift_id).single();
  if (error || !data) throw { code: 404, error_code: "SHIFT_NOT_FOUND", message: "Servicio no encontrado", category: "BUSINESS", details: { shift_id } };
  if (data.state !== "finalizado") {
    throw {
      code: 409,
      error_code: "SHIFT_NOT_FINALIZED",
      message: "Solo servicios finalizados pueden aprobarse o rechazarse",
      category: "BUSINESS",
      details: { current_state: data.state },
    };
  }
}
