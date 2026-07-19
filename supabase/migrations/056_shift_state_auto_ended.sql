-- 056_shift_state_auto_ended.sql
-- New shift state for services the backend closes automatically once the
-- scheduled window ends (#1: auto-close at scheduled_end). Kept in its own
-- migration because a new enum value cannot be USED in the same transaction
-- that adds it — the code that writes 'auto_ended' ships in a later deploy step.
--
-- Effect on existing logic: 'auto_ended' is not 'activo', so it frees the
-- one-active-shift unique index and lets the contractor start a new service.

begin;

alter type public.shift_state add value if not exists 'auto_ended';

commit;
