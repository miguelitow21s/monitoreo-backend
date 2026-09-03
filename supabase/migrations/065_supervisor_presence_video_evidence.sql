-- 065_supervisor_presence_video_evidence.sql
-- Allow video evidence on supervisor presence (inspector audits).
--
-- The UX now opens the iOS native camera with photo OR video in one picker, so an
-- inspector can attach a short clip of a reported issue (leak, breakage, etc.).
-- supervisor_presence_logs.evidence_mime_type had a CHECK limited to images, which
-- rejected the INSERT for a video even after the Edge schema/sniff accepted it.
-- Add the video mimes the sniff produces (mp4 / quicktime / webm). The client may
-- label a .mov as the non-standard "video/mov", but the backend stores the SNIFFED
-- mime, so only these three land in the column.
--
-- supervisor_presence_evidences has no mime CHECK, so it needs no change.

begin;

alter table public.supervisor_presence_logs
  drop constraint if exists supervisor_presence_logs_mime_check;

alter table public.supervisor_presence_logs
  add constraint supervisor_presence_logs_mime_check
  check (
    evidence_mime_type is null
    or evidence_mime_type = any (array[
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'video/mp4', 'video/quicktime', 'video/webm'
    ]::text[])
  );

commit;
