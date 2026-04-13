-- 039_bulk_assign_created_items.sql
-- Return created_items mapping for bulk schedule assignments.

begin;
drop function if exists public.bulk_assign_scheduled_shifts(jsonb);
create or replace function public.bulk_assign_scheduled_shifts(
  p_entries jsonb
)
returns table (
  total integer,
  created integer,
  failed integer,
  created_ids bigint[],
  errors jsonb,
  created_items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_item jsonb;
  v_employee_id uuid;
  v_restaurant_id integer;
  v_start timestamptz;
  v_end timestamptz;
  v_notes text;
  v_id bigint;
  v_total integer := 0;
  v_created integer := 0;
  v_failed integer := 0;
  v_ids bigint[] := '{}';
  v_errors jsonb := '[]'::jsonb;
  v_created_items jsonb := '[]'::jsonb;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'No autenticado';
  end if;

  v_actor_role := public.actor_role_secure();
  if v_actor_role not in ('super_admin', 'supervisora') then
    raise exception 'No autorizado para programar turnos';
  end if;

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'p_entries debe ser un arreglo json';
  end if;

  for v_item in select value from jsonb_array_elements(p_entries)
  loop
    v_total := v_total + 1;

    begin
      v_employee_id := (v_item ->> 'employee_id')::uuid;
      v_restaurant_id := (v_item ->> 'restaurant_id')::integer;
      v_start := (v_item ->> 'scheduled_start')::timestamptz;
      v_end := (v_item ->> 'scheduled_end')::timestamptz;
      v_notes := nullif(trim(v_item ->> 'notes'), '');

      if v_employee_id is null or v_restaurant_id is null or v_start is null or v_end is null then
        raise exception 'Campos requeridos faltantes en item %', v_total;
      end if;

      if v_actor_role = 'supervisora' and not public.is_supervisor_for_restaurant(v_restaurant_id) then
        raise exception 'Sin alcance para restaurante %', v_restaurant_id;
      end if;

      v_id := public.assign_scheduled_shift(v_employee_id, v_restaurant_id, v_start, v_end, v_notes);
      v_created := v_created + 1;
      v_ids := array_append(v_ids, v_id);
      v_created_items := v_created_items || jsonb_build_array(
        jsonb_build_object(
          'index', v_total,
          'scheduled_shift_id', v_id,
          'employee_id', v_employee_id,
          'restaurant_id', v_restaurant_id,
          'scheduled_start', v_start,
          'scheduled_end', v_end,
          'notes', v_notes
        )
      );
    exception when others then
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_array(
        jsonb_build_object(
          'index', v_total,
          'error', sqlerrm,
          'payload', v_item
        )
      );
    end;
  end loop;

  return query
  select v_total, v_created, v_failed, v_ids, v_errors, v_created_items;
end;
$$;
grant execute on function public.bulk_assign_scheduled_shifts(jsonb) to authenticated;
commit;
