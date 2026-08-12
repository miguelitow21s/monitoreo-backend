-- 061_email_notifications_task_completed_event.sql
--
-- Add a notification event for "a site task was completed", so the person who
-- created the task (and the site's supervisors) get told -- with who did it,
-- where, when, their notes and links to the evidence. Extends the allowed
-- event_type set; every existing value stays.

begin;

alter table public.email_notifications
  drop constraint if exists email_notifications_event_type_check;

alter table public.email_notifications
  add constraint email_notifications_event_type_check
  check (event_type in (
    'shift_scheduled',
    'shift_started',
    'shift_ended',
    'shift_not_started',
    'incident_created',
    'shift_approved',
    'shift_rejected',
    'operational_task_completed'
  ));

commit;
