-- 038_shifts_early_end_reason.sql
-- Persist early_end_reason for reports and audit.

begin;

alter table public.shifts
  add column if not exists early_end_reason text;

commit;
