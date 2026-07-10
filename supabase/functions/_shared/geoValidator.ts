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
    .select("id, name, lat, lng, radius, geofence_radius_m")
    .eq("id", restaurant_id)
    .single();

  if (error || !restaurant) {
    throw { code: 422, error_code: "RESTAURANT_INVALID", message: "Restaurante invalido", category: "VALIDATION", details: { restaurant_id } };
  }

  const settings = options.settings;
  const radius = Number.isFinite(restaurant.geofence_radius_m)
    ? restaurant.geofence_radius_m
    : Number.isFinite(restaurant.radius)
      ? restaurant.radius
      : settings?.gps.default_radius_meters;

  if (!radius || !Number.isFinite(radius)) {
    throw {
      code: 422,
      error_code: "GEOFENCE_NOT_CONFIGURED",
      message: "El sitio no tiene geocerca configurada",
      category: "VALIDATION",
      details: { restaurant_id, restaurant_name: restaurant.name },
    };
  }

  if (settings?.gps.min_accuracy_meters && options.accuracy !== null && options.accuracy !== undefined) {
    if (options.accuracy > settings.gps.min_accuracy_meters) {
      throw {
        code: 422,
        error_code: "GPS_ACCURACY_INSUFFICIENT",
        message: "La precision del GPS es insuficiente. Muevete a un lugar con mejor senal e intenta de nuevo",
        category: "VALIDATION",
        details: { accuracy_m: options.accuracy, required_accuracy_m: settings.gps.min_accuracy_meters },
      };
    }
  }

  const dist = earthDistance(restaurant.lat, restaurant.lng, lat, lng);
  if (dist > radius) {
    throw {
      code: 409,
      error_code: "GPS_OUT_OF_RANGE",
      message: `Estas fuera del rango permitido para ${restaurant.name}: ${Math.round(dist)} m del sitio (radio ${Math.round(radius)} m)`,
      category: "BUSINESS",
      details: {
        restaurant_id: restaurant.id,
        restaurant_name: restaurant.name,
        distance_m: Math.round(dist),
        radius_m: Math.round(radius),
        provided_lat: lat,
        provided_lng: lng,
        restaurant_lat: restaurant.lat,
        restaurant_lng: restaurant.lng,
      },
    };
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
    throw { code: 422, error_code: "SHIFT_INVALID", message: "Servicio invalido", category: "VALIDATION", details: { shift_id } };
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
