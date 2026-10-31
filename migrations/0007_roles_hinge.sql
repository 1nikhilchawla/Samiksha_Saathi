-- Officer roles in the database (see src/lib/samiksha/core/rbac.ts), in three parts.
--
-- 1. hinge_decisions: the audit trail of executed hinge pivots (who, what, when).
-- 2. A trigger on tasks that checks the role the server declares for its
--    transaction (set_config('app.current_role', ...)): only a BEO approves a
--    task, only a DEO closes a vacancy task. Paths that set no role (field
--    replies, the overdue sweep, seeding) are not checked. Until sign-in exists
--    the server takes that role from the browser, so this is a second check on
--    the server's own writes, not authentication.
-- 3. Read limits by role for signed-in clients: a CRCC or HM reading directly
--    (Supabase JWT app_metadata.officer_role / person_id / cluster) sees only
--    their own tasks, messages and schools, and no contacts or model ledger.
--    These are restrictive policies on top of the block rule in 0003_rls.sql.
--    No write policies are added: direct client writes stay denied.
-- Plain Postgres syntax only, so the same file applies to PGlite in dev.

create table if not exists hinge_decisions (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  code text not null check (code in ('HP-1', 'HP-2', 'HP-3', 'HP-4', 'HP-5')),
  pivot_id text not null,
  officer_role text not null check (officer_role in ('SPD', 'DEO', 'BEO', 'CRCC', 'HM')),
  summary jsonb not null,
  changes jsonb not null
);
create unique index if not exists hinge_decisions_block_request_uq on hinge_decisions (block_id, client_request_id);
create index if not exists hinge_decisions_cycle_idx on hinge_decisions (cycle_id, id);

create or replace function samiksha_current_role() returns text
language sql stable
set search_path = pg_catalog
as $$
  select upper(coalesce(
    nullif(current_setting('app.current_role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'officer_role'
  ))
$$;

create or replace function samiksha_current_person() returns text
language sql stable
set search_path = pg_catalog
as $$
  select coalesce(
    nullif(current_setting('app.person_id', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'person_id'
  )
$$;

create or replace function samiksha_current_cluster() returns text
language sql stable
set search_path = pg_catalog
as $$
  select coalesce(
    nullif(current_setting('app.cluster', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'cluster'
  )
$$;

-- 2. Role guard on task status changes.
create or replace function samiksha_task_role_guard() returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  r text := upper(nullif(current_setting('app.current_role', true), ''));
  prev text := null;
begin
  if r is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    prev := old.status;
  end if;
  if new.status = 'approved' and prev is distinct from 'approved' and r <> 'BEO' then
    raise exception 'ROLE_FORBIDDEN: only a BEO may approve a task (role %)', r using errcode = '42501';
  end if;
  if new.action_id = 'vacancy' and new.status = 'done' and prev is distinct from 'done' and r <> 'DEO' then
    raise exception 'ROLE_FORBIDDEN: only a DEO may close a vacancy task (role %)', r using errcode = '42501';
  end if;
  return new;
end
$$;

drop trigger if exists tasks_role_guard on tasks;
create trigger tasks_role_guard before insert or update of status on tasks
  for each row execute function samiksha_task_role_guard();

-- 3. Read limits by role (restrictive: they narrow the block rule, never widen it).
create policy role_limits_tasks on tasks as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM') or owner_id = samiksha_current_person()
);
create policy role_limits_messages on messages as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM') or person_id = samiksha_current_person()
);
create policy role_limits_schools on schools as restrictive for select using (
  case coalesce(samiksha_current_role(), 'BEO')
    when 'CRCC' then cluster = samiksha_current_cluster()
    when 'HM' then 'hm-' || code = samiksha_current_person()
    else true
  end
);
create policy role_limits_contacts on contacts as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM')
);
create policy role_limits_llm_calls on llm_calls as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM')
);

alter table hinge_decisions enable row level security;
create policy beo_reads_own_block on hinge_decisions for select using (block_id = samiksha_current_block());
create policy role_limits_hinge_decisions on hinge_decisions as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM')
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on hinge_decisions to authenticated;
  end if;
end
$$;
