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
export async function autoCloseOverdueShifts(params: {
  employeeId?: string;
  limit?: number;
}): Promise<{ closed: number; shift_ids: number[] }> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 200);

  let activeQuery = clientAdmin
    .from("shifts")
    .select("id, employee_id, restaurant_id")
    .eq("state", "activo")
    .limit(limit);

  if (params.employeeId) activeQuery = activeQuery.eq("employee_id", params.employeeId);

  const { data: activeShifts, error: activeError } = await activeQuery;
  if (activeError || !activeShifts || activeShifts.length === 0) {
    return { closed: 0, shift_ids: [] };
  }

  const shiftIds = activeShifts.map((s) => Number(s.id)).filter((n) => Number.isFinite(n));
  if (shiftIds.length === 0) return { closed: 0, shift_ids: [] };

  const { data: schedules, error: schedError } = await clientAdmin
    .from("scheduled_shifts")
    .select("id, started_shift_id, scheduled_end, status")
    .in("started_shift_id", shiftIds);

  if (schedError || !schedules) return { closed: 0, shift_ids: [] };

  const nowIso = new Date().toISOString();
  const closedIds: number[] = [];

  for (const sched of schedules as Array<{ id: number; started_shift_id: number | null; scheduled_end: string | null }>) {
    const shiftId = Number(sched.started_shift_id);
    if (!Number.isFinite(shiftId) || !sched.scheduled_end) continue;
    if (sched.scheduled_end >= nowIso) continue; // window still open

    // Close at the scheduled end so recorded hours match the planned window.
    const { data: updated, error: closeError } = await clientAdmin
      .from("shifts")
      .update({ state: "auto_ended", end_time: sched.scheduled_end, updated_at: nowIso })
      .eq("id", shiftId)
      .eq("state", "activo")
      .select("id");

    if (closeError || !updated || updated.length === 0) continue;

    await clientAdmin
      .from("scheduled_shifts")
      .update({ status: "completed", updated_at: nowIso })
      .eq("id", sched.id)
      .in("status", ["scheduled", "started"]);

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
