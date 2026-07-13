-- 052_cleanup_duplicate_trusted_devices.sql
-- One-time data cleanup + hard enforcement of the "one active trusted device per
-- user" rule (app-level MAX_TRUSTED_DEVICES_PER_USER = 1). Several users
-- accumulated 2-9 active devices (fallout of the OTP/device grant issue closed in
-- migration 048). This revokes all but the most recently seen active device per
-- user, then adds a unique partial index so the DB enforces the limit going
-- forward. Idempotent: re-running revokes nothing once each user has <= 1 active.

begin;

-- 1) Revoke every active device except the most recently seen one per user.
update public.user_trusted_devices d
set revoked_at = now(),
    revoked_by = d.user_id,
    updated_at = now()
where d.revoked_at is null
  and d.id <> (
    select d2.id
    from public.user_trusted_devices d2
    where d2.user_id = d.user_id
      and d2.revoked_at is null
    order by d2.last_seen_at desc nulls last, d2.trusted_at desc
    limit 1
  );

-- 2) Enforce one active device per user at the DB level from now on.
create unique index if not exists uq_user_trusted_devices_one_active
  on public.user_trusted_devices (user_id)
  where revoked_at is null;

commit;
