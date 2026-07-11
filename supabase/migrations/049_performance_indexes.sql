-- 049_performance_indexes.sql
-- Performance audit fixes (A4/A5/M1): add indexes for columns filtered on hot
-- paths that currently cause sequential scans. Purely additive, no data change.

begin;

-- A4: scheduled_shifts.started_shift_id is filtered on every dashboard load
-- (employee_self_service) and every shift end (shifts_end), and in reports.
create index if not exists idx_scheduled_shifts_started_shift
  on public.scheduled_shifts (started_shift_id)
  where started_shift_id is not null;

-- A5: restaurant_employees.user_id is filtered on every dashboard load, but the
-- only index is UNIQUE(restaurant_id, user_id) where user_id is not the leading
-- column, so it cannot serve predicates on user_id alone.
create index if not exists idx_restaurant_employees_user
  on public.restaurant_employees (user_id);

-- M1(perf): scheduled_shifts is filtered by status + scheduled_start for overdue
-- notifications and dashboard metrics, not covered by (employee_id, scheduled_start).
create index if not exists idx_scheduled_shifts_status_start
  on public.scheduled_shifts (status, scheduled_start);

commit;
