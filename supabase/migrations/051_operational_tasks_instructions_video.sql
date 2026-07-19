-- 051_operational_tasks_instructions_video.sql
-- Instructions video for special tasks: the inspector (supervisora/super_admin)
-- attaches a short video when creating the task; the contractor plays it inline.
-- Download-only, inspector -> contractor. Evidence uploaded by the contractor
-- stays a photo (see evidence_type). Stored in the shift-evidence bucket under
-- the task-instructions/<restaurant_id>/ prefix; served via signed URLs.

begin;

alter table public.operational_tasks
  add column if not exists instructions_video_path text;

commit;