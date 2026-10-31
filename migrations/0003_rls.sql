-- Row-level security: a BEO reading the database directly (Supabase client with
-- their JWT) sees only rows of their own block. The block comes from the JWT
-- claim app_metadata.block_id (set server-side in Supabase Auth), or from the
-- session setting app.block_id for plain-Postgres clients.
--
-- The app server connects as the table owner (or Supabase service_role), which
-- bypasses RLS, and scopes every query by block_id itself. No write policies are
-- defined, so direct client writes are denied. Plain Postgres syntax only, so
-- the same file applies to PGlite in dev.

create or replace function samiksha_current_block() returns text
language sql stable
set search_path = pg_catalog
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata' ->> 'block_id',
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'block_id',
    nullif(current_setting('app.block_id', true), '')
  )
$$;

alter table cycles enable row level security;
alter table schools enable row level security;
alter table issues enable row level security;
alter table gaps enable row level security;
alter table tasks enable row level security;
alter table messages enable row level security;
alter table scorecard_snapshots enable row level security;
alter table llm_calls enable row level security;
alter table contacts enable row level security;

create policy beo_reads_own_block on cycles for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on schools for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on issues for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on gaps for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on tasks for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on messages for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on scorecard_snapshots for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on llm_calls for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on contacts for select using (block_id = samiksha_current_block());

-- The view runs with its caller's rights, so RLS on tasks applies through it.
alter view outbound_queue set (security_invoker = true);

-- On Supabase, signed-in clients may read (RLS above narrows it to their block);
-- anon gets nothing. Skipped where those roles do not exist (PGlite, plain Postgres).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema public to authenticated;
    grant select on cycles, schools, issues, gaps, tasks, messages, scorecard_snapshots, llm_calls, contacts, outbound_queue to authenticated;
  end if;
end
$$;
