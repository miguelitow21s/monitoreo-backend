-- 011_idempotency_locking.sql
-- Hardening for idempotency race conditions and payload replay safety

begin;

alter table if exists public.idempotency_records
  add column if not exists payload_hash text,
  add column if not exists status text not null default 'processing',
  add column if not exists in_progress_started_at timestamptz,
  add column if not exists completed_at timestamptz;

create index if not exists idx_idempotency_records_status on public.idempotency_records(status);

create or replace function public.idempotency_claim(
  p_user_id uuid,
  p_endpoint text,
  p_key text,
  p_payload_hash text
)
returns table (
  outcome text,
  status_code integer,
  response_body jsonb
)
language plpgsql
as $$
declare
  v_rec public.idempotency_records%rowtype;
  v_inserted integer := 0;
begin
  if p_payload_hash is null or length(p_payload_hash) < 16 then
    raise exception 'payload hash invalido';
  end if;

  insert into public.idempotency_records (
    user_id,
    endpoint,
    idempotency_key,
    payload_hash,
    status,
    in_progress_started_at,
    updated_at
  )
  values (
    p_user_id,
    p_endpoint,
    p_key,
    p_payload_hash,
    'processing',
    now(),
    now()
  )
  on conflict do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    return query select 'claimed'::text, null::integer, null::jsonb;
    return;
  end if;

  select * into v_rec
  from public.idempotency_records
  where user_id = p_user_id
    and endpoint = p_endpoint
    and idempotency_key = p_key
  for update;

  if not found then
    return query select 'processing'::text, null::integer, null::jsonb;
    return;
  end if;

  if v_rec.payload_hash is not null and v_rec.payload_hash <> p_payload_hash then
    return query select 'payload_conflict'::text, null::integer, null::jsonb;
    return;
  end if;

  if v_rec.status = 'completed' and v_rec.status_code is not null then
    return query select 'replay'::text, v_rec.status_code, v_rec.response_body;
    return;
  end if;

  if v_rec.status = 'processing' and v_rec.in_progress_started_at is not null and v_rec.in_progress_started_at > now() - interval '2 minutes' then
    return query select 'processing'::text, null::integer, null::jsonb;
    return;
  end if;

  update public.idempotency_records
  set
    payload_hash = p_payload_hash,
    status = 'processing',
    in_progress_started_at = now(),
    updated_at = now(),
    status_code = null,
    response_body = null,
    completed_at = null
  where user_id = p_user_id
    and endpoint = p_endpoint
    and idempotency_key = p_key;

  return query select 'claimed'::text, null::integer, null::jsonb;
end;
$$;

create or replace function public.idempotency_finalize(
  p_user_id uuid,
  p_endpoint text,
  p_key text,
  p_status_code integer,
  p_response_body jsonb
)
returns void
language plpgsql
as $$
begin
  update public.idempotency_records
  set
    status_code = p_status_code,
    response_body = p_response_body,
    status = 'completed',
    completed_at = now(),
    updated_at = now()
  where user_id = p_user_id
    and endpoint = p_endpoint
    and idempotency_key = p_key;
end;
$$;

-- Backward compatibility for previous helper calls
create or replace function public.idempotency_begin(
  p_user_id uuid,
  p_endpoint text,
  p_key text
)
returns table (
  is_new boolean,
  status_code integer,
  response_body jsonb
)
language plpgsql
as $$
begin
  return query
  with c as (
    select * from public.idempotency_claim(p_user_id, p_endpoint, p_key, 'legacy-no-hash')
  )
  select
    (c.outcome = 'claimed') as is_new,
    c.status_code,
    c.response_body
  from c;
end;
$$;

create or replace function public.idempotency_finish(
  p_user_id uuid,
  p_endpoint text,
  p_key text,
  p_status_code integer,
  p_response_body jsonb
)
returns void
language plpgsql
as $$
begin
  perform public.idempotency_finalize(p_user_id, p_endpoint, p_key, p_status_code, p_response_body);
end;
$$;

commit;
