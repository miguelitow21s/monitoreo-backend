import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { SystemSettings } from "./systemSettings.ts";

type GeoOptions = {
  settings?: SystemSettings;
  accuracy?: number | null;
};

export async function geoValidatorByRestaurant(
  client: SupabaseClient,
  restaurant_id: number,
  lat: number,
  lng: number,
  options: GeoOptions = {}
) {
  const { data: restaurant, error } = await client
    .from("restaurants")
    .select("id, lat, lng, radius, geofence_radius_m")
    .eq("id", restaurant_id)
    .single();

  if (error || !restaurant) {
    throw { code: 422, message: "Restaurante invalido", category: "VALIDATION" };
  }

  const settings = options.settings;
  const radius = Number.isFinite(restaurant.geofence_radius_m)
    ? restaurant.geofence_radius_m
    : Number.isFinite(restaurant.radius)
      ? restaurant.radius
      : settings?.gps.default_radius_meters;

  if (!radius || !Number.isFinite(radius)) {
    throw { code: 422, message: "Restaurante sin geocerca configurada", category: "VALIDATION" };
  }

  if (settings?.gps.min_accuracy_meters && options.accuracy !== null && options.accuracy !== undefined) {
    if (options.accuracy > settings.gps.min_accuracy_meters) {
      throw { code: 422, message: "Precision GPS insuficiente", category: "VALIDATION" };
    }
  }

  const dist = earthDistance(restaurant.lat, restaurant.lng, lat, lng);
  if (dist > radius) {
    throw { code: 409, message: "GPS fuera de radio", category: "BUSINESS" };
  }

  return restaurant;
}

export async function geoValidatorByShift(
  client: SupabaseClient,
  shift_id: number,
  lat: number,
  lng: number,
  options: GeoOptions = {}
) {
  const { data: shift, error: shiftErr } = await client
    .from("shifts")
    .select("id, restaurant_id")
    .eq("id", shift_id)
    .single();

  if (shiftErr || !shift) {
    throw { code: 422, message: "Turno invalido", category: "VALIDATION" };
  }

  await geoValidatorByRestaurant(client, shift.restaurant_id, lat, lng, options);
}

function earthDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
