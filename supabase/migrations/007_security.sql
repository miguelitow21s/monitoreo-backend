-- 04_security.sql
-- FASE 4: SEGURIDAD (RLS, REVOKES, GRANTS MINIMOS, POLICIES)

begin;

-- 0) Tablas requeridas por seguridad legal (idempotente)
create table if not exists public.legal_terms_versions (
  id bigserial primary key,
  code text not null unique,
  title text not null,
  content text not null,
  version text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid null references public.users(id) on delete set null
);

create table if not exists public.user_legal_acceptances (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  legal_terms_id bigint not null references public.legal_terms_versions(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  ip_address inet null,
  user_agent text null,
  unique (user_id, legal_terms_id)
);

create table if not exists public.shift_health_forms (
  id bigserial primary key,
  shift_id integer not null references public.shifts(id) on delete cascade,
  phase text not null check (phase in ('start', 'end')),
  fit_for_work boolean not null,
  declaration text null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid not null references public.users(id) on delete restrict,
  unique (shift_id, phase)
);

-- 0.1) Columna requerida por policy de audit_logs
alter table public.audit_logs
  add column if not exists actor_user_id uuid;

-- 1) Helpers de seguridad (sin auth.role)
create or replace function public.actor_role_secure()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.name::text
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.id = auth.uid()
  limit 1;
$$;

create or replace function public.is_supervisor_for_restaurant(p_restaurant_id integer)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.restaurant_employees re
    where re.restaurant_id = p_restaurant_id
      and re.user_id = auth.uid()
  );
$$;

revoke execute on function public.actor_role_secure() from public;
revoke execute on function public.is_supervisor_for_restaurant(integer) from public;
grant execute on function public.actor_role_secure() to authenticated;
grant execute on function public.is_supervisor_for_restaurant(integer) to authenticated;

-- 2) RLS enable
alter table public.shifts enable row level security;
alter table public.incidents enable row level security;
alter table public.scheduled_shifts enable row level security;
alter table public.supplies enable row level security;
alter table public.reports enable row level security;
alter table public.audit_logs enable row level security;
alter table public.legal_terms_versions enable row level security;
alter table public.user_legal_acceptances enable row level security;
alter table public.shift_health_forms enable row level security;

-- 3) Limpiar policies previas en tablas criticas (evita OR permisivo)
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'shifts','incidents','scheduled_shifts','supplies','reports','audit_logs',
        'legal_terms_versions','user_legal_acceptances','shift_health_forms'
      )
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- 4) REVOKE/GRANT minimo en tablas
revoke all on table public.shifts from public, anon;
revoke all on table public.incidents from public, anon;
revoke all on table public.scheduled_shifts from public, anon;
revoke all on table public.supplies from public, anon;
revoke all on table public.reports from public, anon;
revoke all on table public.audit_logs from public, anon;
revoke all on table public.legal_terms_versions from public, anon;
revoke all on table public.user_legal_acceptances from public, anon;
revoke all on table public.shift_health_forms from public, anon;

grant select, update on table public.shifts to authenticated;
grant select, insert on table public.incidents to authenticated;
grant select on table public.scheduled_shifts to authenticated;
grant select on table public.supplies to authenticated;
grant select on table public.reports to authenticated;
grant select, insert on table public.audit_logs to authenticated;
grant select on table public.legal_terms_versions to authenticated;
grant select, insert on table public.user_legal_acceptances to authenticated;
grant select, insert on table public.shift_health_forms to authenticated;

-- 5) Policies por ownership/rol

-- SHIFTS
create policy shifts_select_hardened
on public.shifts
for select to authenticated
using (
  employee_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
  or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
);

create policy shifts_update_hardened
on public.shifts
for update to authenticated
using (
  public.actor_role_secure() = 'super_admin'
  or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
)
with check (
  public.actor_role_secure() = 'super_admin'
  or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
);

-- INCIDENTS
create policy incidents_select_hardened
on public.incidents
for select to authenticated
using (
  public.actor_role_secure() = 'super_admin'
  or exists (
    select 1
    from public.shifts s
    where s.id = incidents.shift_id
      and (
        s.employee_id = auth.uid()
        or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(s.restaurant_id))
      )
  )
);

create policy incidents_insert_hardened
on public.incidents
for insert to authenticated
with check (
  created_by = auth.uid()
  and (
    public.actor_role_secure() = 'super_admin'
    or exists (
      select 1
      from public.shifts s
      where s.id = incidents.shift_id
        and (
          s.employee_id = auth.uid()
          or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(s.restaurant_id))
        )
    )
  )
);

-- SCHEDULED SHIFTS
create policy scheduled_shifts_select_hardened
on public.scheduled_shifts
for select to authenticated
using (
  employee_id = auth.uid()
  or public.actor_role_secure() = 'super_admin'
  or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
);

create policy scheduled_shifts_write_hardened
on public.scheduled_shifts
for all to authenticated
using (
  public.actor_role_secure() = 'super_admin'
  or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
)
with check (
  public.actor_role_secure() = 'super_admin'
  or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(restaurant_id))
);

-- SUPPLIES
create policy supplies_select_hardened
on public.supplies
for select to authenticated
using (
  public.actor_role_secure() = 'super_admin'
  or (
    public.actor_role_secure() = 'supervisora'
    and restaurant_id is not null
    and public.is_supervisor_for_restaurant(restaurant_id)
  )
);

create policy supplies_write_hardened
on public.supplies
for all to authenticated
using (
  public.actor_role_secure() = 'super_admin'
  or (
    public.actor_role_secure() = 'supervisora'
    and restaurant_id is not null
    and public.is_supervisor_for_restaurant(restaurant_id)
  )
)
with check (
  public.actor_role_secure() = 'super_admin'
  or (
    public.actor_role_secure() = 'supervisora'
    and restaurant_id is not null
    and public.is_supervisor_for_restaurant(restaurant_id)
  )
);

-- REPORTS
create policy reports_select_hardened
on public.reports
for select to authenticated
using (public.actor_role_secure() in ('super_admin','supervisora'));

create policy reports_write_hardened
on public.reports
for all to authenticated
using (public.actor_role_secure() = 'super_admin')
with check (public.actor_role_secure() = 'super_admin');

-- AUDIT LOGS
create policy audit_logs_select_hardened
on public.audit_logs
for select to authenticated
using (public.actor_role_secure() in ('super_admin','supervisora'));

create policy audit_logs_insert_hardened
on public.audit_logs
for insert to authenticated
with check (coalesce(actor_user_id, actor_id, user_id) = auth.uid());

-- LEGAL TERMS
create policy legal_terms_versions_select_hardened
on public.legal_terms_versions
for select to authenticated
using (is_active = true or public.actor_role_secure() in ('super_admin','supervisora'));

-- LEGAL ACCEPTANCES
create policy user_legal_acceptances_select_hardened
on public.user_legal_acceptances
for select to authenticated
using (user_id = auth.uid() or public.actor_role_secure() in ('super_admin','supervisora'));

create policy user_legal_acceptances_insert_hardened
on public.user_legal_acceptances
for insert to authenticated
with check (user_id = auth.uid());

-- HEALTH FORMS
create policy shift_health_forms_select_hardened
on public.shift_health_forms
for select to authenticated
using (
  recorded_by = auth.uid()
  or public.actor_role_secure() = 'super_admin'
  or exists (
    select 1 from public.shifts s
    where s.id = shift_health_forms.shift_id
      and (s.employee_id = auth.uid() or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(s.restaurant_id)))
  )
);

create policy shift_health_forms_insert_hardened
on public.shift_health_forms
for insert to authenticated
with check (recorded_by = auth.uid());

commit;
