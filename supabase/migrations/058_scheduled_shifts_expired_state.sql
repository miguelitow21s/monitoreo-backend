-- 058_scheduled_shifts_expired_state.sql
--
-- A scheduled service whose window closed without the contractor ever starting it
-- used to stay 'scheduled' forever. Two consequences:
--   1) It vanished from the contractor's app with no trace, so neither they nor an
--      auditor could tell the service had been assigned and missed.
--   2) It stayed in the pool the overdue-alert queue reads from, which is how a
--      cron resurrected three months of stale shifts and drained the mail quota.
--
-- 'expired' states the fact (the window closed) without asserting intent. We
-- cannot prove from data whether the contractor chose not to show up, was
-- reassigned, or the service was called off by phone, so the label stays factual.

begin;

alter table public.scheduled_shifts
  drop constraint if exists scheduled_shifts_status_check;

alter table public.scheduled_shifts
  add constraint scheduled_shifts_status_check
  check (status in ('scheduled', 'started', 'completed', 'cancelled', 'expired'));

-- Backfill: services whose window closed and that were never started.
-- 'started_shift_id is null' keeps anything that actually ran untouched.
update public.scheduled_shifts
set status = 'expired',
    updated_at = now()
where status = 'scheduled'
  and started_shift_id is null
  and scheduled_end < now() - interval '1 hour';

-- Let an inspector rebook a service that expired. Without this the only way out
-- of 'expired' is creating a new row, losing the link to the original plan.
create or replace function public.reschedule_scheduled_shift(
  p_scheduled_shift_id bigint,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_row public.scheduled_shifts%rowtype;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para reprogramar turnos';
  end if;

  if p_scheduled_end <= p_scheduled_start then
    raise exception 'Rango horario invalido';
  end if;

  select * into v_row
  from public.scheduled_shifts s
  where s.id = p_scheduled_shift_id;

  if not found then
    raise exception 'Turno programado no encontrado';
  end if;

  if v_row.status not in ('scheduled', 'expired') then
    raise exception 'Solo se puede reprogramar un turno programado o vencido';
  end if;

  update public.scheduled_shifts
  set
    scheduled_start = p_scheduled_start,
    scheduled_end = p_scheduled_end,
    -- Rebooking puts an expired service back in play.
    status = 'scheduled',
    notes = coalesce(nullif(trim(p_notes), ''), notes),
    updated_at = now()
  where id = p_scheduled_shift_id;
end;
$$;

grant execute on function public.reschedule_scheduled_shift(bigint, timestamptz, timestamptz, text) to authenticated;

commit;
