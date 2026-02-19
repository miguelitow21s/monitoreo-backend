-- 06_triggers.sql
-- FASE 6: TRIGGERS (AUDITORIA, INMUTABILIDAD, SINCRONIZACION)

begin;

-- 1) Columna adicional para auditoria fuerte
alter table public.audit_logs
  add column if not exists actor_user_id uuid;

-- 2) Trigger: actor tomado de auth.uid()
create or replace function public.trg_audit_logs_set_actor()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  new.actor_user_id := auth.uid();
  new.actor_id := auth.uid();
  new.user_id := auth.uid();
  return new;
end;
$$;

-- 3) Trigger: bloquear mutaciones de audit_logs
create or replace function public.trg_audit_logs_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs es append-only';
end;
$$;

-- 4) Trigger: sincronizar shifts.state <-> shifts.status
create or replace function public.trg_sync_shift_state_status()
returns trigger
language plpgsql
as $$
begin
  if new.state is not null then
    new.status := case new.state::text
      when 'activo' then 'active'
      when 'finalizado' then 'completed'
      when 'aprobado' then 'approved'
      when 'rechazado' then 'rejected'
      else new.state::text
    end;
  elsif new.status is not null then
    new.state := case lower(new.status)
      when 'active' then 'activo'::public.shift_state
      when 'completed' then 'finalizado'::public.shift_state
      when 'approved' then 'aprobado'::public.shift_state
      when 'rejected' then 'rechazado'::public.shift_state
      else 'activo'::public.shift_state
    end;
  end if;

  return new;
end;
$$;

-- 5) Trigger: evidencia inmutable + metadatos minimos cuando hay path
create or replace function public.trg_shifts_evidence_immutability()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if old.start_evidence_path is not null and new.start_evidence_path is distinct from old.start_evidence_path then
      raise exception 'start_evidence_path es inmutable';
    end if;

    if old.end_evidence_path is not null and new.end_evidence_path is distinct from old.end_evidence_path then
      raise exception 'end_evidence_path es inmutable';
    end if;

    if old.start_evidence_hash is not null and new.start_evidence_hash is distinct from old.start_evidence_hash then
      raise exception 'start_evidence_hash es inmutable';
    end if;

    if old.end_evidence_hash is not null and new.end_evidence_hash is distinct from old.end_evidence_hash then
      raise exception 'end_evidence_hash es inmutable';
    end if;
  end if;

  if new.start_evidence_path is not null then
    if new.start_evidence_created_at is null or new.start_evidence_uploaded_by is null then
      raise exception 'Metadatos minimos faltantes en evidencia de inicio';
    end if;
  end if;

  if new.end_evidence_path is not null then
    if new.end_evidence_created_at is null or new.end_evidence_uploaded_by is null then
      raise exception 'Metadatos minimos faltantes en evidencia de fin';
    end if;
  end if;

  return new;
end;
$$;

-- 6) Trigger: bloquear alteracion historica de turnos cerrados
create or replace function public.trg_shifts_block_closed_history_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.end_time is not null then
    if new.start_time is distinct from old.start_time
       or new.start_lat is distinct from old.start_lat
       or new.start_lng is distinct from old.start_lng
       or new.end_time is distinct from old.end_time
       or new.end_lat is distinct from old.end_lat
       or new.end_lng is distinct from old.end_lng
       or new.employee_id is distinct from old.employee_id
       or new.restaurant_id is distinct from old.restaurant_id then
      raise exception 'Turno cerrado: datos historicos inmutables';
    end if;
  end if;

  return new;
end;
$$;

-- 7) Trigger: defaults en supply_deliveries
create or replace function public.trg_supply_deliveries_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.delivered_at is null then
    new.delivered_at := now();
  end if;

  if new.delivered_by is null then
    new.delivered_by := auth.uid();
  end if;

  return new;
end;
$$;

-- Re-crear triggers de forma idempotente

do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'tr_audit_logs_set_actor') then
    drop trigger tr_audit_logs_set_actor on public.audit_logs;
  end if;
  create trigger tr_audit_logs_set_actor
  before insert on public.audit_logs
  for each row execute function public.trg_audit_logs_set_actor();

  if exists (select 1 from pg_trigger where tgname = 'tr_audit_logs_block_mutation') then
    drop trigger tr_audit_logs_block_mutation on public.audit_logs;
  end if;
  create trigger tr_audit_logs_block_mutation
  before update or delete on public.audit_logs
  for each row execute function public.trg_audit_logs_block_mutation();

  if exists (select 1 from pg_trigger where tgname = 'tr_sync_shift_state_status') then
    drop trigger tr_sync_shift_state_status on public.shifts;
  end if;
  create trigger tr_sync_shift_state_status
  before insert or update on public.shifts
  for each row execute function public.trg_sync_shift_state_status();

  if exists (select 1 from pg_trigger where tgname = 'tr_shifts_evidence_immutability') then
    drop trigger tr_shifts_evidence_immutability on public.shifts;
  end if;
  create trigger tr_shifts_evidence_immutability
  before insert or update on public.shifts
  for each row execute function public.trg_shifts_evidence_immutability();

  if exists (select 1 from pg_trigger where tgname = 'tr_shifts_block_closed_history_mutation') then
    drop trigger tr_shifts_block_closed_history_mutation on public.shifts;
  end if;
  create trigger tr_shifts_block_closed_history_mutation
  before update on public.shifts
  for each row execute function public.trg_shifts_block_closed_history_mutation();

  if exists (select 1 from pg_trigger where tgname = 'tr_supply_deliveries_defaults') then
    drop trigger tr_supply_deliveries_defaults on public.supply_deliveries;
  end if;
  create trigger tr_supply_deliveries_defaults
  before insert on public.supply_deliveries
  for each row execute function public.trg_supply_deliveries_defaults();
end $$;

commit;
