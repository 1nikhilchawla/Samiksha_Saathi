-- 0010 — close the outbound rate window to the client role.
--
-- The rate window (one row per second, shared by every queue worker) is a
-- server-side counter. It carries no personal data and no client reads it, so
-- row-level security is switched on without a read policy: the server role
-- bypasses RLS, and everyone else sees nothing.

alter table queue_rate_window enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke select on queue_rate_window from authenticated;
  end if;
end
$$;
