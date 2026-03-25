import { z } from "npm:zod@3.23.8";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const defaultSettings = {
  security: {
    pin_length: 6,
    force_password_change_on_first_login: false,
    otp_expiration_minutes: 10,
    trusted_device_days: 30,
  },
  legal: {
    consent_text: "Autorizo el uso de mis datos personales, ubicacion GPS y camara para fines de verificacion de turnos laborales.",
    support_email: "soporte@worktrace.com",
  },
  gps: {
    default_radius_meters: 100,
    min_accuracy_meters: 100,
    require_gps_for_shift_start: true,
    require_gps_for_supervision: true,
  },
  shifts: {
    default_hours: 6,
    min_hours: 1,
    max_hours: 12,
    early_start_tolerance_minutes: 1440,
    late_start_tolerance_minutes: 0,
  },
  evidence: {
    require_start_photos: true,
    require_end_photos: true,
    require_supervision_photos: true,
    default_cleaning_areas: ["Cocina", "Comedor", "Banos", "Patio"],
    areas_mode: "restaurant_or_default",
  },
  tasks: {
    require_special_task_completion_check: true,
    require_special_task_notes: true,
  },
};

const securitySchema = z.object({
  pin_length: z.number().int().min(4).max(12),
  force_password_change_on_first_login: z.boolean(),
  otp_expiration_minutes: z.number().int().min(1).max(120),
  trusted_device_days: z.number().int().min(1).max(3650),
});

const legalSchema = z.object({
  consent_text: z.string().trim().min(5).max(5000),
  support_email: z.string().trim().email().max(160),
});

const gpsSchema = z.object({
  default_radius_meters: z.number().int().min(10).max(20000),
  min_accuracy_meters: z.number().int().min(1).max(10000),
  require_gps_for_shift_start: z.boolean(),
  require_gps_for_supervision: z.boolean(),
});

const shiftsSchema = z.object({
  default_hours: z.number().min(1).max(24),
  min_hours: z.number().min(1).max(24),
  max_hours: z.number().min(1).max(24),
  early_start_tolerance_minutes: z.number().int().min(0).max(10080),
  late_start_tolerance_minutes: z.number().int().min(0).max(10080),
});

const evidenceSchema = z.object({
  require_start_photos: z.boolean(),
  require_end_photos: z.boolean(),
  require_supervision_photos: z.boolean(),
  default_cleaning_areas: z.array(z.string().trim().min(1).max(120)).max(200),
  areas_mode: z.enum(["restaurant_or_default", "default_only", "restaurant_only"]),
});

const tasksSchema = z.object({
  require_special_task_completion_check: z.boolean(),
  require_special_task_notes: z.boolean(),
});

const settingsSchema = z
  .object({
    security: securitySchema,
    legal: legalSchema,
    gps: gpsSchema,
    shifts: shiftsSchema,
    evidence: evidenceSchema,
    tasks: tasksSchema,
  })
  .strict();

const settingsPatchSchema = z
  .object({
    security: securitySchema.partial().optional(),
    legal: legalSchema.partial().optional(),
    gps: gpsSchema.partial().optional(),
    shifts: shiftsSchema.partial().optional(),
    evidence: evidenceSchema.partial().optional(),
    tasks: tasksSchema.partial().optional(),
  })
  .strict();

export type SystemSettings = z.infer<typeof settingsSchema>;
export type SystemSettingsPatch = z.infer<typeof settingsPatchSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeDeep(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

let cachedSettings: { value: SystemSettings; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export function validateSettingsPatch(patch: unknown): SystemSettingsPatch {
  return settingsPatchSchema.parse(patch ?? {});
}

export function normalizeSettings(settings: unknown): SystemSettings {
  const merged = mergeDeep(defaultSettings as Record<string, unknown>, (settings ?? {}) as Record<string, unknown>);
  return settingsSchema.parse(merged);
}

export function mergeSettings(current: SystemSettings, patch: SystemSettingsPatch): SystemSettings {
  const merged = mergeDeep(current as Record<string, unknown>, patch as Record<string, unknown>);
  return settingsSchema.parse(merged);
}

export async function getSystemSettings(client: SupabaseClient): Promise<SystemSettings> {
  if (cachedSettings && Date.now() - cachedSettings.fetchedAt < CACHE_TTL_MS) {
    return cachedSettings.value;
  }

  const { data, error } = await client
    .from("system_settings")
    .select("id, settings")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    throw { code: 500, message: "No se pudo cargar configuracion", category: "SYSTEM", details: error };
  }

  if (!data?.id) {
    const { error: insertError } = await client
      .from("system_settings")
      .insert({ id: 1, settings: defaultSettings })
      .eq("id", 1);

    if (insertError) {
      throw { code: 500, message: "No se pudo inicializar configuracion", category: "SYSTEM", details: insertError };
    }
  }

  const normalized = normalizeSettings(data?.settings ?? {});
  cachedSettings = { value: normalized, fetchedAt: Date.now() };
  return normalized;
}

export function resolveCleaningAreas(
  settings: SystemSettings,
  restaurantAreas: unknown
): unknown {
  const mode = settings.evidence.areas_mode ?? "restaurant_or_default";
  const hasRestaurantAreas = Array.isArray(restaurantAreas) && restaurantAreas.length > 0;

  if (mode === "restaurant_only") {
    return hasRestaurantAreas ? restaurantAreas : [];
  }

  if (mode === "default_only") {
    return settings.evidence.default_cleaning_areas;
  }

  return hasRestaurantAreas ? restaurantAreas : settings.evidence.default_cleaning_areas;
}
