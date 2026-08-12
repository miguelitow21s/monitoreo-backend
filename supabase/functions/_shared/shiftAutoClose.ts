import { clientAdmin } from "./supabaseClient.ts";
import { notifyShiftEvent } from "./emailNotifications.ts";

// Auto-close services whose scheduled window already ended (#1).
//
// A contractor may forget to end a shift; once `scheduled_end` passes we close it
// ourselves so it stops showing as active, the one-active-shift constraint frees
// up, and hours are recorded against the scheduled end (not "now", which would
// inflate them). The shift lands in state 'auto_ended' so the app can tell it
// apart from a normal manual close.
//
// Called opportunistically on employee reads (dashboard), so the app sees the
// state flip on its next poll without needing a cron.
/**
 * Mark scheduled services whose window closed without ever being started.
 *
 * Without this they stay 'scheduled' forever: they disappear from the app with no
 * trace (the contractor and the auditor lose the fact that a service was assigned
 * and missed) and they stay in the pool the overdue-alert queue reads from, which
 * is how a cron once resurrected three months of stale shifts.
 *
 * The one-hour grace after `scheduled_end` leaves room for the "not started"
 * alert to have fired first, so expiring never suppresses a legitimate warning.
 */
export async function expireOverdueScheduledShifts(params?: {
  employeeId?: string;
  limit?: number;
  graceMinutes?: number;
}): Promise<{ expired: number }> {
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 500);
  const graceMinutes = Math.min(Math.max(params?.graceMinutes ?? 60, 0), 24 * 60);
  const cutoffIso = new Date(Date.now() - graceMinutes * 60_000).toISOString();

  let query = clientAdmin
    .from("scheduled_shifts")
    .select("id")
    .eq("status", "scheduled")
    .is("started_shift_id", null)
    .lt("scheduled_end", cutoffIso)
    .limit(limit);

  if (params?.employeeId) query = query.eq("employee_id", params.employeeId);

  const { data: stale, error } = await query;
  if (error || !stale || stale.length === 0) return { expired: 0 };

  const ids = stale.map((row) => Number(row.id)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return { expired: 0 };

  // Re-check the status in the update so a service started between the read and
  // the write is never stomped.
  const { data: updated, error: updateError } = await clientAdmin
    .from("scheduled_shifts")
    .update({ status: "expired", updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("status", "scheduled")
    .is("started_shift_id", null)
    .select("id");

  if (updateError) return { expired: 0 };
  return { expired: updated?.length ?? 0 };
}

/**
 * Safety-net cap for a visit nobody closed. A scheduled shift closes at its
 * planned end; an ad-hoc visit has no planned end, so it closes this many hours
 * after it started. Long enough to never cut a real deep-clean night short.
 */
const MAX_AD_HOC_VISIT_HOURS = 16;

export async function autoCloseOverdueShifts(params: {
  employeeId?: string;
  limit?: number;
}): Promise<{ closed: number; shift_ids: number[] }> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 200);

  let activeQuery = clientAdmin
    .from("shifts")
    .select("id, employee_id, restaurant_id, start_time")
    .eq("state", "activo")
    .limit(limit);

  if (params.employeeId) activeQuery = activeQuery.eq("employee_id", params.employeeId);

  const { data: activeShifts, error: activeError } = await activeQuery;
  if (activeError || !activeShifts || activeShifts.length === 0) {
    return { closed: 0, shift_ids: [] };
  }

  const shiftIds = activeShifts.map((s) => Number(s.id)).filter((n) => Number.isFinite(n));
  if (shiftIds.length === 0) return { closed: 0, shift_ids: [] };

  // A shift may (legacy) be linked to a scheduled window; if so we close it at
  // that planned end. Ad-hoc visits have no schedule and fall to the time cap.
  const { data: schedules } = await clientAdmin
    .from("scheduled_shifts")
    .select("id, started_shift_id, scheduled_end")
    .in("started_shift_id", shiftIds);

  const scheduleByShift = new Map<number, { id: number; scheduled_end: string | null }>();
  for (const s of (schedules ?? []) as Array<{ id: number; started_shift_id: number | null; scheduled_end: string | null }>) {
    const sid = Number(s.started_shift_id);
    if (Number.isFinite(sid)) scheduleByShift.set(sid, { id: s.id, scheduled_end: s.scheduled_end });
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const closedIds: number[] = [];

  for (const shift of activeShifts as Array<{ id: number; start_time: string | null }>) {
    const shiftId = Number(shift.id);
    if (!Number.isFinite(shiftId)) continue;

    const sched = scheduleByShift.get(shiftId);

    // Pick the close time: the planned end for a scheduled shift, otherwise the
    // ad-hoc cap measured from when the visit started. `endTimeIso` also keeps
    // recorded hours honest (never "now", which would inflate a forgotten visit).
    let endTimeIso: string | null = null;
    if (sched?.scheduled_end) {
      if (sched.scheduled_end < nowIso) endTimeIso = sched.scheduled_end;
    } else if (shift.start_time) {
      const cap = new Date(shift.start_time).getTime() + MAX_AD_HOC_VISIT_HOURS * 3600_000;
      if (Number.isFinite(cap) && cap < now) endTimeIso = new Date(cap).toISOString();
    }
    if (!endTimeIso) continue; // still within its window / cap

    const { data: updated, error: closeError } = await clientAdmin
      .from("shifts")
      .update({ state: "auto_ended", end_time: endTimeIso, updated_at: nowIso })
      .eq("id", shiftId)
      .eq("state", "activo")
      .select("id");

    if (closeError || !updated || updated.length === 0) continue;

    if (sched) {
      await clientAdmin
        .from("scheduled_shifts")
        .update({ status: "completed", updated_at: nowIso })
        .eq("id", sched.id)
        .in("status", ["scheduled", "started"]);
    }

    closedIds.push(shiftId);
  }

  // Notify contractor + stakeholders; never let a notification failure block the read.
  for (const shiftId of closedIds) {
    try {
      const owner = activeShifts.find((s) => Number(s.id) === shiftId);
      await notifyShiftEvent({
        eventType: "shift_ended",
        shiftId,
        actorUserId: String(owner?.employee_id ?? ""),
      });
    } catch (_err) {
      // best-effort
    }
  }

  return { closed: closedIds.length, shift_ids: closedIds };
}
