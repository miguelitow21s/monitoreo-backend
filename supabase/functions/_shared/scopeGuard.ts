import { clientAdmin } from "./supabaseClient.ts";

export async function ensureUserRestaurantAccess(userId: string, restaurantId: number) {
  const { data, error } = await clientAdmin
    .from("restaurant_employees")
    .select("restaurant_id")
    .eq("user_id", userId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle();

  if (error || !data) {
    throw { code: 403, message: "Sin acceso a este sitio", category: "PERMISSION" };
  }
}

export async function ensureSupervisorRestaurantAccess(_supervisorId: string, _restaurantId: number) {
  // Inspectors (supervisora role) have global site access — no assignment required.
}

export async function ensureSupervisorShiftAccess(supervisorId: string, shiftId: number) {
  const { data: shift, error: shiftErr } = await clientAdmin
    .from("shifts")
    .select("id, restaurant_id")
    .eq("id", shiftId)
    .single();

  if (shiftErr || !shift) {
    throw { code: 404, message: "Servicio no encontrado", category: "BUSINESS" };
  }

  await ensureSupervisorRestaurantAccess(supervisorId, shift.restaurant_id);
}
