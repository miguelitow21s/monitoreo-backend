begin;

do $$
declare
  v_active_id bigint;
  v_latest_id bigint;
begin
  -- Ensure there is at least one active legal version so legal_consent/status never returns 503.
  select id
  into v_active_id
  from public.legal_terms_versions
  where is_active = true
  order by created_at desc, id desc
  limit 1;

  if v_active_id is null then
    select id
    into v_latest_id
    from public.legal_terms_versions
    order by created_at desc, id desc
    limit 1;

    if v_latest_id is not null then
      update public.legal_terms_versions
      set is_active = true
      where id = v_latest_id;
    else
      insert into public.legal_terms_versions (
        code,
        title,
        content,
        version,
        is_active,
        created_at,
        created_by
      ) values (
        'default-privacy-terms',
        'Tratamiento de datos personales',
        'Al continuar en la plataforma, aceptas el tratamiento de tus datos personales para operacion, seguridad y cumplimiento legal.',
        '1.0.0',
        true,
        now(),
        null
      );
    end if;
  end if;
end $$;

commit;

