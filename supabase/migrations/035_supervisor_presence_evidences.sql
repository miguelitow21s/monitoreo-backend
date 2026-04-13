-- 035_supervisor_presence_evidences.sql
-- Support multiple evidences per supervisor presence

begin;
alter table public.supervisor_presence_logs
  alter column evidence_path drop not null,
  alter column evidence_hash drop not null,
  alter column evidence_mime_type drop not null,
  alter column evidence_size_bytes drop not null;
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'supervisor_presence_logs_evidence_size_check'
      and conrelid = 'public.supervisor_presence_logs'::regclass
  ) then
    alter table public.supervisor_presence_logs drop constraint supervisor_presence_logs_evidence_size_check;
  end if;

  alter table public.supervisor_presence_logs
    add constraint supervisor_presence_logs_evidence_size_check
    check (evidence_size_bytes is null or evidence_size_bytes > 0);

  if exists (
    select 1 from pg_constraint
    where conname = 'supervisor_presence_logs_mime_check'
      and conrelid = 'public.supervisor_presence_logs'::regclass
  ) then
    alter table public.supervisor_presence_logs drop constraint supervisor_presence_logs_mime_check;
  end if;

  alter table public.supervisor_presence_logs
    add constraint supervisor_presence_logs_mime_check
    check (
      evidence_mime_type is null
      or evidence_mime_type in ('image/jpeg', 'image/png', 'image/webp')
    );
end $$;
create table if not exists public.supervisor_presence_evidences (
  id bigserial primary key,
  presence_id bigint not null references public.supervisor_presence_logs(id) on delete cascade,
  storage_path text not null,
  sha256 text not null,
  mime_type text not null,
  size_bytes bigint not null,
  label text null,
  created_at timestamptz not null default now()
);
create index if not exists idx_supervisor_presence_evidences_presence
  on public.supervisor_presence_evidences (presence_id);
alter table public.supervisor_presence_evidences enable row level security;
revoke all on table public.supervisor_presence_evidences from public, anon;
grant select, insert on table public.supervisor_presence_evidences to authenticated;
do $$
declare
  p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'supervisor_presence_evidences'
  loop
    execute format('drop policy %I on public.supervisor_presence_evidences', p.policyname);
  end loop;

  create policy supervisor_presence_evidences_select_scoped
  on public.supervisor_presence_evidences
  for select to authenticated
  using (
    exists (
      select 1
      from public.supervisor_presence_logs l
      where l.id = supervisor_presence_evidences.presence_id
        and (
          l.supervisor_id = auth.uid()
          or public.actor_role_secure() = 'super_admin'
          or (public.actor_role_secure() = 'supervisora' and public.is_supervisor_for_restaurant(l.restaurant_id))
        )
    )
  );

  create policy supervisor_presence_evidences_insert_scoped
  on public.supervisor_presence_evidences
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.supervisor_presence_logs l
      where l.id = supervisor_presence_evidences.presence_id
        and l.supervisor_id = auth.uid()
    )
  );
end $$;
commit;
