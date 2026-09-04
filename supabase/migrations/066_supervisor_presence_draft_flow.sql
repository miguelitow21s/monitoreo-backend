-- 066_supervisor_presence_draft_flow.sql
-- Progressive evidence upload for inspector audits.
--
-- Today `register` creates the presence log AND attaches every photo at once
-- (download+hash of up to 50 files in one call -> the 60-90s block the inspector
-- waits at the end). The new flow lets the app create the audit as a DRAFT on
-- arrival, attach each photo in the background while the inspector walks the site,
-- and finalize with just the notes.
--
-- Changes:
--   * supervisor_presence_logs.status ('draft' | 'completed'). Existing rows and
--     the legacy `register` path are 'completed' (default), so nothing regresses.
--   * supervisor_presence_evidences.meta (jsonb) for per-photo area/subarea/source
--     metadata the client sends on attach (parity with contractor shift_photos).
--   * Partial indexes to find an inspector's open draft and to scan drafts for
--     the abandoned-draft cleanup.

begin;

alter table public.supervisor_presence_logs
  add column if not exists status text not null default 'completed';

alter table public.supervisor_presence_logs
  drop constraint if exists supervisor_presence_logs_status_check;
alter table public.supervisor_presence_logs
  add constraint supervisor_presence_logs_status_check
  check (status in ('draft', 'completed'));

alter table public.supervisor_presence_evidences
  add column if not exists meta jsonb;

-- Fast lookup of an inspector's open draft for a restaurant (start / get_active_draft).
create index if not exists idx_presence_logs_open_draft
  on public.supervisor_presence_logs (supervisor_id, restaurant_id)
  where status = 'draft';

-- Scan for abandoned drafts (cleanup job).
create index if not exists idx_presence_logs_draft_recorded
  on public.supervisor_presence_logs (recorded_at)
  where status = 'draft';

commit;
