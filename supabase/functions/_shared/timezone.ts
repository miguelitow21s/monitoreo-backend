// Resolve an IANA timezone (e.g. "America/Los_Angeles") from a restaurant's
// coordinates. Used so scheduling/display happen in the restaurant's local time.
//
// tz-lookup is a small offline dataset (no network) that maps lat/lng -> IANA zone.
import tzlookup from "npm:tz-lookup@6.1.25";

export const DEFAULT_TIMEZONE = "America/Los_Angeles";

// Basic sanity check: IANA zones look like "Area/Location" (optionally "Area/Sub/Location").
const IANA_RE = /^[A-Za-z]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?$/;

export function isValidIanaTimezone(tz: unknown): tz is string {
  return typeof tz === "string" && (tz === "UTC" || IANA_RE.test(tz));
}

export function resolveTimezoneFromCoords(
  lat: number,
  lng: number,
  fallback: string = DEFAULT_TIMEZONE
): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fallback;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return fallback;
  try {
    const tz = tzlookup(lat, lng);
    return isValidIanaTimezone(tz) ? tz : fallback;
  } catch {
    return fallback;
  }
}
