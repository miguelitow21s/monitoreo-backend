create or replace function public.trg_supervisor_presence_guard()
returns trigger
language plpgsql
as $$
declare
  v_role text;
  v_lat double precision;
  v_lng double precision;
  v_radius integer;
  v_actor uuid;
begin
  v_actor := auth.uid();

  if v_actor is not null then
    v_role := public.actor_role_secure();
    if v_role not in ('supervisora', 'super_admin') then
      raise exception 'Solo supervision puede registrar presencia';
    end if;

    if v_role = 'supervisora' and not public.is_supervisor_for_restaurant(new.restaurant_id) then
      raise exception 'Supervisora no asignada al restaurante';
    end if;

    new.supervisor_id := v_actor;
  else
    if new.supervisor_id is null then
      raise exception 'Supervisor invalido';
    end if;
  end if;

  select r.lat, r.lng, r.radius
    into v_lat, v_lng, v_radius
  from public.restaurants r
  where r.id = new.restaurant_id;

  if v_lat is null or v_lng is null or v_radius is null then
    raise exception 'Restaurante invalido o sin geocerca configurada';
  end if;

  if earth_distance(ll_to_earth(v_lat, v_lng), ll_to_earth(new.lat, new.lng)) > v_radius then
    raise exception 'GPS fuera de geocerca';
  end if;

  new.recorded_at := coalesce(new.recorded_at, now());
  return new;
end;
$$;
