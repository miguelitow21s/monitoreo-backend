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

// ---------------------------------------------------------------------------
// Wall-clock time
//
// A service happens at a site, so the hour someone types when scheduling is the
// hour AT THAT SITE. Whoever schedules it may sit in another country; their
// clock is an accident of geography, not part of the service.
//
// Instants are stored as `timestamptz`. These helpers are the only place that
// converts between "6pm in Los Angeles" and that instant, so the conversion
// cannot drift between callers.
// ---------------------------------------------------------------------------

/** Usable zone or the Pacific fallback: the product is used in the US. */
export function safeTimezone(tz: unknown): string {
  if (!isValidIanaTimezone(tz)) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The wall-clock parts an observer in `timezone` sees at `instant`. */
export function localPartsAt(instant: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone(timezone),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = Number(part.value);
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: (map.hour ?? 0) % 24, // some runtimes render midnight as 24
    minute: map.minute ?? 0,
    second: map.second ?? 0,
  };
}

/** Milliseconds to add to an instant to get the wall clock in `timezone`. */
function offsetMsAt(instantMs: number, timezone: string): number {
  const p = localPartsAt(new Date(instantMs), timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instantMs;
}

/**
 * "6pm on 2026-07-20 in America/Los_Angeles" -> the absolute instant.
 *
 * Two passes because the offset depends on the instant itself: the first guess
 * can land on the wrong side of a DST boundary and the second settles it.
 */
export function wallClockToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const tz = safeTimezone(timezone);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instantMs = target;
  for (let i = 0; i < 2; i += 1) {
    instantMs = target - offsetMsAt(instantMs, tz);
  }
  return new Date(instantMs);
}

/** Parses "YYYY-MM-DD" + "HH:MM" as wall clock at the site. */
export function parseWallClock(dateText: unknown, timeText: unknown, timezone: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText ?? "").trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(timeText ?? "").trim());
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59) return null;

  const instant = wallClockToUtc(year, month, day, hour, minute, timezone);
  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Exclusive upper bound of "today" at the site: the instant local midnight
 * turns over. A service counts as "in play today" when it starts before this.
 */
export function endOfLocalDay(now: Date, timezone: string): Date {
  const tz = safeTimezone(timezone);
  const p = localPartsAt(now, tz);
  // day + 1 overflows into the next month/year safely via Date.UTC.
  return wallClockToUtc(p.year, p.month, p.day + 1, 0, 0, tz);
}

/** Local calendar day at the site, as "YYYY-MM-DD". */
export function localDateKey(instant: Date, timezone: string): string {
  const p = localPartsAt(instant, safeTimezone(timezone));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Display strings in the site's own clock, so no client has to do timezone
 * arithmetic to render a service correctly.
 */
export function formatAtSite(
  instant: Date | string | null | undefined,
  timezone: string
): { local_date: string; local_time: string; local_text: string; tz_label: string } | null {
  if (!instant) return null;
  const date = instant instanceof Date ? instant : new Date(String(instant));
  if (Number.isNaN(date.getTime())) return null;

  const tz = safeTimezone(timezone);
  const local_time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);

  const tz_label =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "";

  const local_date = localDateKey(date, tz);

  return {
    local_date,
    local_time,
    local_text: `${local_date} ${local_time}${tz_label ? ` (${tz_label})` : ""}`,
    tz_label,
  };
}
