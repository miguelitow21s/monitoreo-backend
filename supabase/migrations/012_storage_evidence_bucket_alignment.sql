-- 012_storage_evidence_bucket_alignment.sql
-- Align storage bucket + policies to canonical bucket used by Edge Functions: shift-evidence

begin;

do $$
begin
  -- Ensure canonical private bucket exists
  begin
    insert into storage.buckets (id, name, public)
    values ('shift-evidence', 'shift-evidence', false)
    on conflict (id) do update
      set public = excluded.public;
  exception
    when insufficient_privilege then
      raise notice 'No permission to create/update storage.buckets. Configure shift-evidence bucket manually in Storage.';
  end;

  -- Enable RLS on storage.objects if allowed
  begin
    execute 'alter table storage.objects enable row level security';
  exception
    when insufficient_privilege then
      raise notice 'No permission to alter storage.objects. Configure policies manually in Storage.';
  end;

  -- Remove legacy and previous policy variants when present
  begin execute 'drop policy if exists evidence_select on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists evidence_insert on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists evidence_update on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists evidence_delete on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists shift_evidence_select on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists shift_evidence_insert on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists shift_evidence_update on storage.objects'; exception when undefined_object then null; end;
  begin execute 'drop policy if exists shift_evidence_delete on storage.objects'; exception when undefined_object then null; end;

  -- Recreate strict policies bound to canonical bucket
  begin
    execute '
      create policy shift_evidence_select
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
      )';

    execute '
      create policy shift_evidence_insert
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
      )';

    execute '
      create policy shift_evidence_update
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
      )
      with check (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
      )';

    execute '
      create policy shift_evidence_delete
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = ''shift-evidence''
        and owner_id::text = auth.uid()::text
      )';
  exception
    when insufficient_privilege then
      raise notice 'No permission to manage storage.objects policies. Apply shift-evidence policies manually in Storage.';
  end;
end $$;

commit;
