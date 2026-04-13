-- 031_storage_evidence_policies_uid_prefix_fallback.sql
-- Broaden storage path validation to accept common uid-based prefixes used by frontend clients.

begin;
create or replace function public.is_allowed_shift_evidence_path(p_name text, p_uid uuid)
returns boolean
language sql
stable
as $$
  select
    -- Preferred canonical prefixes
    p_name like format('users/%s/task-close/%%', p_uid::text)
    or p_name like format('users/%s/task-mid/%%', p_uid::text)
    or p_name like format('users/%s/task-wide/%%', p_uid::text)
    or p_name like format('users/%s/task-manifest/%%', p_uid::text)
    or p_name like format('users/%s/task-evidence/%%', p_uid::text)
    or p_name like format('users/%s/supervisor-start/%%', p_uid::text)
    or p_name like format('users/%s/supervisor-end/%%', p_uid::text)

    -- Additional supervisor variants seen in mobile/front implementations
    or p_name like format('users/%s/supervisor/%%', p_uid::text)
    or p_name like format('users/%s/supervision/%%', p_uid::text)

    -- Backward compatibility for legacy evidence_upload paths
    or p_name like format('%s/%%/inicio/%%', p_uid::text)
    or p_name like format('%s/%%/fin/%%', p_uid::text)

    -- Generic uid-bound fallback: supports either "<uid>/..." or "users/<uid>/..."
    or split_part(p_name, '/', 1) = p_uid::text
    or (split_part(p_name, '/', 1) = 'users' and split_part(p_name, '/', 2) = p_uid::text);
$$;
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
        bucket_id in (''shift-evidence'', ''evidence'')
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';

    execute '
      create policy shift_evidence_insert
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id in (''shift-evidence'', ''evidence'')
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';

    execute '
      create policy shift_evidence_update
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id in (''shift-evidence'', ''evidence'')
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )
      with check (
        bucket_id in (''shift-evidence'', ''evidence'')
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';

    execute '
      create policy shift_evidence_delete
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id in (''shift-evidence'', ''evidence'')
        and public.is_allowed_shift_evidence_path(name, auth.uid())
      )';
  exception
    when insufficient_privilege then
      raise notice 'No permission to manage storage.objects policies. Apply storage policies manually in Storage.';
  end;
end $$;
commit;
