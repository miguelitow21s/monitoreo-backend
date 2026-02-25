-- 014_frontend_contract_alignment.sql
-- Align backend contract with frontend operational tasks, supervisor presence and reports requirements.

begin;

-- ---------------------------------------------------------
-- 1) Storage helper for allowed shift-evidence prefixes
-- ---------------------------------------------------------
create or replace function public.is_allowed_shift_evidence_path(p_name text, p_uid uuid)
returns boolean
language sql
stable
as $$
  select
    p_name like format('users/%s/task-close/%%', p_uid::text)
    or p_name like format('users/%s/task-mid/%%', p_uid::text)
    or p_name like format('users/%s/task-wide/%%', p_uid::text)
    or p_name like format('users/%s/task-manifest/%%', p_uid::text)
    or p_name like format('users/%s/supervisor-start/%%', p_uid::text)
    or p_name like format('users/%s/supervisor-end/%%', p_uid::text)
    -- Backward compatibility for legacy evidence_upload paths
    or p_name like format('%s/%%/inicio/%%', p_uid::text)
    or p_name like format('%s/%%/fin/%%', p_uid::text);
$$;

-- ---------------------------------------------------------
-- 2) operational_tasks table + integrity rules
-- ---------------------------------------------------------
create table if not exists public.operational_tasks (
  id bigserial primary key,
  shift_id integer not null references public.shifts(id) on delete restrict,
  restaurant_id integer not null references public.restaurants(id) on delete restrict,
  assigned_employee_id uuid not null references public.users(id) on delete restrict,
  created_by uuid not null references public.users(id) on delete restrict,
  title text not null,
  description text not null,
  priority text not null default 'normal',
  status text not null default 'pending',
  due_at timestamptz null,
  resolved_at timestamptz null,
  resolved_by uuid null references public.users(id) on delete set null,
  evidence_path text null,
  evidence_hash text null,
  evidence_mime_type text null,
  evidence_size_bytes bigint null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.operational_tasks
  add column if not exists shift_id integer references public.shifts(id) on delete restrict,
  add column if not exists restaurant_id integer references public.restaurants(id) on delete restrict,
  add column if not exists assigned_employee_id uuid references public.users(id) on delete restrict,
  add column if not exists created_by uuid references public.users(id) on delete restrict,
  add column if not exists title text,
  add column if not exists description text,
  add column if not exists priority text default 'normal',
  add column if not exists status text default 'pending',
  add column if not exists due_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references public.users(id) on delete set null,
  add column if not exists evidence_path text,
  add column if not exists evidence_hash text,
  add column if not exists evidence_mime_type text,
  add column if not exists evidence_size_bytes bigint,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.operational_tasks
set
  priority = coalesce(priority, 'normal'),
  status = coalesce(status, 'pending'),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now())
where priority is null
   or status is null
   or created_at is null
   or updated_at is null;

do $$
begin
  if not exists (select 1 from public.operational_tasks where shift_id is null) then
    alter table public.operational_tasks alter column shift_id set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where restaurant_id is null) then
    alter table public.operational_tasks alter column restaurant_id set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where assigned_employee_id is null) then
    alter table public.operational_tasks alter column assigned_employee_id set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where created_by is null) then
    alter table public.operational_tasks alter column created_by set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where title is null) then
    alter table public.operational_tasks alter column title set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where description is null) then
    alter table public.operational_tasks alter column description set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where priority is null) then
    alter table public.operational_tasks alter column priority set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where status is null) then
    alter table public.operational_tasks alter column status set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where created_at is null) then
    alter table public.operational_tasks alter column created_at set not null;
  end if;
  if not exists (select 1 from public.operational_tasks where updated_at is null) then
    alter table public.operational_tasks alter column updated_at set not null;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'operational_tasks_priority_check'
      and conrelid = 'public.operational_tasks'::regclass
  ) then
    alter table public.operational_tasks
      add constraint operational_tasks_priority_check
      check (priority in ('low', 'normal', 'high', 'critical'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'operational_tasks_status_check'
      and conrelid = 'public.operational_tasks'::regclass
  ) then
    alter table public.operational_tasks
      add constraint operational_tasks_status_check
      check (status in ('pending', 'in_progress', 'completed', 'cancelled'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'operational_tasks_due_at_check'
      and conrelid = 'public.operational_tasks'::regclass
  ) then
    alter table public.operational_tasks
      add constraint operational_tasks_due_at_check
      check (due_at is null or due_at >= created_at);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'operational_tasks_evidence_size_check'
      and conrelid = 'public.operational_tasks'::regclass
  ) then
    alter table public.operational_tasks
      add constraint operational_tasks_evidence_size_check
      check (evidence_size_bytes is null or evidence_size_bytes > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'operational_tasks_evidence_mime_check'
      and conrelid = 'public.operational_tasks'::regclass
  ) then
    alter table public.operational_tasks
      add constraint operational_tasks_evidence_mime_check
      check (
        evidence_mime_type is null
        or evidence_mime_type in ('application/json', 'image/jpeg', 'image/png', 'image/webp')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'operational_tasks_completed_payload_check'
      and conrelid = 'public.operational_tasks'::regclass
  ) then
    alter table public.operational_tasks
      add constraint operational_tasks_completed_payload_check
      check (
        status <> 'completed'
        or (
          resolved_at is not null
          and resolved_by is not null
          and evidence_path is not null
          and evidence_hash is not null
          and evidence_mime_type is not null
          and evidence_size_bytes is not null
        )
      );
  end if;
end $$;

create index if not exists idx_operational_tasks_restaurant_status_due
  on public.operational_tasks (restaurant_id, status, due_at);

create index if not exists idx_operational_tasks_assigned_status
  on public.operational_tasks (assigned_employee_id, status, updated_at desc);

create or replace function public.operational_tasks_guard_update()
returns trigger
language plpgsql
as $$
declare
  v_role text;
  v_uid uuid;
begin
  new.updated_at := now();

  if tg_op <> 'UPDATE' then
    return new;
  end if;

  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'No autenticado';
  end if;

  v_role := public.actor_role_secure();

  if v_role in ('super_admin', 'supervisora') then
    return new;
  end if;

  if v_role <> 'empleado' then
    raise exception 'Rol no autorizado para actualizar tarea operativa';
  end if;

  if old.assigned_employee_id <> v_uid then
    raise exception 'Solo el empleado asignado puede cerrar la tarea';
  end if;

  if new.shift_id is distinct from old.shift_id
     or new.restaurant_id is distinct from old.restaurant_id
     or new.assigned_employee_id is distinct from old.assigned_employee_id
     or new.created_by is distinct from old.created_by
     or new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.priority is distinct from old.priority
     or new.due_at is distinct from old.due_at
     or new.created_at is distinct from old.created_at then
    raise exception 'Empleado no puede editar datos base de la tarea';
  end if;

  if new.status <> 'completed' then
    raise exception 'Cierre de tarea debe usar estado completed';
  end if;

  if new.resolved_by is null or new.resolved_by <> v_uid then
    raise exception 'resolved_by invalido para cierre de tarea';
  end if;

  if new.resolved_at is null then
    new.resolved_at := now();
  end if;

  if new.evidence_path is null
     or new.evidence_hash is null
     or new.evidence_mime_type is null
     or new.evidence_size_bytes is null then
    raise exception 'Faltan metadatos de evidencia para cerrar tarea';
  end if;

  if new.evidence_mime_type <> 'application/json' then
    raise exception 'La evidencia oficial de cierre debe ser manifest JSON';
  end if;

  if new.evidence_path not like format('users/%s/task-manifest/%%', v_uid::text) then
    raise exception 'Ruta de manifest invalida para cierre de tarea';
  end if;

  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_trigger where tgname = 'tr_operational_tasks_guard_update'
  ) then
    drop trigger tr_operational_tasks_guard_update on public.operational_tasks;
  end if;

  create trigger tr_operational_tasks_guard_update
  before update on public.operational_tasks
  for each row execute function public.operational_tasks_guard_update();
end $$;

alter table public.operational_tasks enable row level security;
revoke all on table public.operational_tasks from public, anon;
grant select, insert, update on table public.operational_tasks to authenticated;

do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'operational_tasks'
  loop
    execute format('drop policy %I on public.operational_tasks', p.policyname);
  end loop;

  create policy operational_tasks_select_scoped
  on public.operational_tasks
  for select to authenticated
  using (
    assigned_employee_id = auth.uid()
    or public.actor_role_secure() = 'super_admin'
    or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
  );

  create policy operational_tasks_insert_supervision
  on public.operational_tasks
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      public.actor_role_secure() = 'super_admin'
      or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
    )
  );

  create policy operational_tasks_update_supervision
  on public.operational_tasks
  for update to authenticated
  using (
    public.actor_role_secure() = 'super_admin'
    or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
  )
  with check (
    public.actor_role_secure() = 'super_admin'
    or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
  );

  create policy operational_tasks_update_employee_closure
  on public.operational_tasks
  for update to authenticated
  using (
    public.actor_role_secure() = 'empleado'
    and assigned_employee_id = auth.uid()
  )
  with check (
    public.actor_role_secure() = 'empleado'
    and assigned_employee_id = auth.uid()
    and resolved_by = auth.uid()
  );
end $$;

-- ---------------------------------------------------------
-- 3) supervisor_presence_logs table + RLS
-- ---------------------------------------------------------
create table if not exists public.supervisor_presence_logs (
  id bigserial primary key,
  supervisor_id uuid not null references public.users(id) on delete restrict,
  restaurant_id integer not null references public.restaurants(id) on delete restrict,
  phase text not null,
  lat double precision not null,
  lng double precision not null,
  evidence_path text not null,
  evidence_hash text not null,
  evidence_mime_type text not null,
  evidence_size_bytes bigint not null,
  recorded_at timestamptz not null default now(),
  notes text null
);

alter table public.supervisor_presence_logs
  add column if not exists supervisor_id uuid references public.users(id) on delete restrict,
  add column if not exists restaurant_id integer references public.restaurants(id) on delete restrict,
  add column if not exists phase text,
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists evidence_path text,
  add column if not exists evidence_hash text,
  add column if not exists evidence_mime_type text,
  add column if not exists evidence_size_bytes bigint,
  add column if not exists recorded_at timestamptz default now(),
  add column if not exists notes text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'supervisor_presence_logs_phase_check'
      and conrelid = 'public.supervisor_presence_logs'::regclass
  ) then
    alter table public.supervisor_presence_logs
      add constraint supervisor_presence_logs_phase_check
      check (phase in ('start', 'end'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'supervisor_presence_logs_lat_check'
      and conrelid = 'public.supervisor_presence_logs'::regclass
  ) then
    alter table public.supervisor_presence_logs
      add constraint supervisor_presence_logs_lat_check
      check (lat between -90 and 90);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'supervisor_presence_logs_lng_check'
      and conrelid = 'public.supervisor_presence_logs'::regclass
  ) then
    alter table public.supervisor_presence_logs
      add constraint supervisor_presence_logs_lng_check
      check (lng between -180 and 180);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'supervisor_presence_logs_evidence_size_check'
      and conrelid = 'public.supervisor_presence_logs'::regclass
  ) then
    alter table public.supervisor_presence_logs
      add constraint supervisor_presence_logs_evidence_size_check
      check (evidence_size_bytes > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'supervisor_presence_logs_mime_check'
      and conrelid = 'public.supervisor_presence_logs'::regclass
  ) then
    alter table public.supervisor_presence_logs
      add constraint supervisor_presence_logs_mime_check
      check (evidence_mime_type in ('image/jpeg', 'image/png', 'image/webp'));
  end if;
end $$;

create index if not exists idx_supervisor_presence_logs_supervisor_recorded
  on public.supervisor_presence_logs (supervisor_id, recorded_at desc);

create index if not exists idx_supervisor_presence_logs_restaurant_recorded
  on public.supervisor_presence_logs (restaurant_id, recorded_at desc);

alter table public.supervisor_presence_logs enable row level security;
revoke all on table public.supervisor_presence_logs from public, anon;
grant select, insert on table public.supervisor_presence_logs to authenticated;

do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'supervisor_presence_logs'
  loop
    execute format('drop policy %I on public.supervisor_presence_logs', p.policyname);
  end loop;

  create policy supervisor_presence_logs_select_scoped
  on public.supervisor_presence_logs
  for select to authenticated
  using (
    supervisor_id = auth.uid()
    or public.actor_role_secure() = 'super_admin'
    or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
  );

  create policy supervisor_presence_logs_insert_scoped
  on public.supervisor_presence_logs
  for insert to authenticated
  with check (
    supervisor_id = auth.uid()
    and (
      public.actor_role_secure() = 'super_admin'
      or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
    )
  );
end $$;

-- ---------------------------------------------------------
-- 4) shift_incidents view hardening (respect invoker RLS)
-- ---------------------------------------------------------
create or replace view public.shift_incidents
with (security_invoker = true)
as
select
  i.id,
  i.shift_id,
  i.description as note,
  i.created_at,
  i.created_by
from public.incidents i;

create or replace function public.shift_incidents_insert()
returns trigger
language plpgsql
as $$
declare
  v_row public.incidents;
begin
  if auth.uid() is null then
    raise exception 'No autenticado';
  end if;

  insert into public.incidents (shift_id, description, created_by)
  values (
    new.shift_id,
    coalesce(new.note, ''),
    auth.uid()
  )
  returning * into v_row;

  new.id := v_row.id;
  new.shift_id := v_row.shift_id;
  new.note := v_row.description;
  new.created_at := v_row.created_at;
  new.created_by := v_row.created_by;
  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from pg_trigger where tgname = 'tr_shift_incidents_insert'
  ) then
    drop trigger tr_shift_incidents_insert on public.shift_incidents;
  end if;

  create trigger tr_shift_incidents_insert
  instead of insert on public.shift_incidents
  for each row execute function public.shift_incidents_insert();
end $$;

-- ---------------------------------------------------------
-- 5) reports RLS by restaurant scope for supervisora
-- ---------------------------------------------------------
grant select, insert on table public.reports to authenticated;
revoke update, delete on table public.reports from authenticated;

do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'reports'
  loop
    execute format('drop policy %I on public.reports', p.policyname);
  end loop;

  create policy reports_select_scoped
  on public.reports
  for select to authenticated
  using (
    public.actor_role_secure() = 'super_admin'
    or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
  );

  create policy reports_insert_scoped
  on public.reports
  for insert to authenticated
  with check (
    public.actor_role_secure() = 'super_admin'
    or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
  );

  create policy reports_update_admin
  on public.reports
  for update to authenticated
  using (public.actor_role_secure() = 'super_admin')
  with check (public.actor_role_secure() = 'super_admin');

  create policy reports_delete_admin
  on public.reports
  for delete to authenticated
  using (public.actor_role_secure() = 'super_admin');
end $$;

-- ---------------------------------------------------------
-- 6) storage.objects policies aligned to official prefixes
-- ---------------------------------------------------------
do $$
begin
  begin execute 'drop policy if exists shift_evidence_select on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists shift_evidence_insert on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists shift_evidence_update on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists shift_evidence_delete on storage.objects'; exception when undefined_object then null; end;

  begin
    execute '
      create policy shift_evidence_select
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';

    execute '
      create policy shift_evidence_insert
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';

    execute '
      create policy shift_evidence_update
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )
      with check (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';

    execute '
      create policy shift_evidence_delete
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';
  exception
    when insufficient_privilege then
      raise notice 'No permission to manage storage.objects policies. Apply shift-evidence policies manually in Storage.';
  end;
end $$;

commit;
