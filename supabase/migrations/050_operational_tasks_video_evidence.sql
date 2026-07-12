-- 050_operational_tasks_video_evidence.sql
-- Support video evidence for special (operational) tasks: a supervisor can create
-- a task that requires a video response, and the contractor answers with a video
-- instead of a photo. Adds an evidence_type discriminator and raises the storage
-- bucket size limit so short videos fit.

begin;

-- photo (default, preserves current behavior) | video | any
alter table public.operational_tasks
  add column if not exists evidence_type text not null default 'photo';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'operational_tasks_evidence_type_check'
  ) then
    alter table public.operational_tasks
      add constraint operational_tasks_evidence_type_check
      check (evidence_type in ('photo', 'video', 'any'));
  end if;
end $$;

-- Raise the evidence bucket per-file limit to 50 MB so short videos upload.
-- (Bucket-level allowed_mime_types stays null; the Edge Function enforces mime.)
do $$
begin
  update storage.buckets set file_size_limit = 52428800 where id = 'shift-evidence';
exception
  when insufficient_privilege then
    raise notice 'No permission to update storage.buckets.file_size_limit; set shift-evidence limit to 50MB manually in Storage.';
end $$;

commit;
