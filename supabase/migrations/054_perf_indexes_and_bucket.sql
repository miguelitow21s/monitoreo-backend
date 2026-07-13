-- 054_perf_indexes_and_bucket.sql
-- Performance audit follow-ups: dashboard/query indexes + a larger evidence
-- bucket limit for instruction videos.

begin;

-- admin_dashboard_metrics filters scheduled_shifts by scheduled_start (+ optional
-- restaurant_id) and operational_tasks by updated_at range — both seq-scan today.
create index if not exists idx_scheduled_shifts_restaurant_start
  on public.scheduled_shifts (restaurant_id, scheduled_start);

create index if not exists idx_operational_tasks_restaurant_updated
  on public.operational_tasks (restaurant_id, updated_at);

-- Instruction videos from a phone can exceed 50 MB; raise the bucket limit.
do $$
begin
  update storage.buckets set file_size_limit = 104857600 where id = 'shift-evidence'; -- 100 MB
exception
  when insufficient_privilege then
    raise notice 'Set shift-evidence file_size_limit to 100MB manually in Storage.';
end $$;

commit;
