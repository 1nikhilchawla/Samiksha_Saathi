-- 0009: hardening and district.
--
-- One migration for the ten remediations, so a pilot database moves in one step:
--   * a signed officer session is auditable (officer_session_log);
--   * a supervisory override is recorded, not just performed (hinge_decisions,
--     task_events, tasks, message_queue);
--   * the to-do list belongs to a person, not to a role;
--   * a school carries its Grade 3 denominator, so small samples can be marked;
--   * a shared phone can hold two officers (contacts);
--   * a DEO can see more than one block (district_blocks_summary);
--   * an inbound Telegram update is logged once (inbound_webhook_dedup);
--   * thresholds can be changed at runtime by the SPD (block_settings);
--   * a proof records the key it was written with, so a rotation orphans nothing.

-- 1. The signed officer session, kept for the audit trail.
create table if not exists officer_session_log (
  id bigint generated always as identity primary key,
  block_id text not null,
  session_jti text not null,
  officer_role text not null,
  person_id text not null,
  cluster text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create unique index if not exists officer_session_log_jti_uq on officer_session_log (session_jti);
create index if not exists officer_session_log_block_idx on officer_session_log (block_id, issued_at desc);

-- 2. The acting officer, on every audited write.
alter table hinge_decisions add column if not exists is_supervisory_override boolean not null default false;
alter table hinge_decisions add column if not exists acted_as_level integer;
alter table hinge_decisions add column if not exists actor_person_id text;

alter table task_events add column if not exists acted_as_level integer;
alter table task_events add column if not exists actor_person_id text;
alter table task_events add column if not exists is_supervisory_override boolean not null default false;

alter table tasks add column if not exists approved_as_level integer;
alter table tasks add column if not exists approved_by_person_id text;
alter table tasks add column if not exists approved_is_override boolean not null default false;

alter table message_queue add column if not exists actor_person_id text;
alter table message_queue add column if not exists acted_as_level integer;
alter table message_queue add column if not exists is_supervisory_override boolean not null default false;

-- 2b. The key a ciphertext was written with, so a key rotation orphans nothing.
alter table encrypted_media_proofs add column if not exists key_id text not null default 'v2';

-- 3. The to-do list belongs to a person. A role-scoped list let two BEOs in one
--    block read and clear each other's items.
alter table officer_todos add column if not exists person_id text not null default 'beo-kesli';
create unique index if not exists officer_todos_person_uq
  on officer_todos (block_id, officer_role, person_id, lower(text))
  where person_id <> '';
drop policy if exists role_limits_officer_todos on officer_todos;
create policy role_limits_officer_todos on officer_todos as restrictive for all
  using (
    officer_role = coalesce(samiksha_current_role(), 'BEO')
    AND (person_id = coalesce(nullif(current_setting('app.current_person_id', true), ''), person_id))
  );

-- 4. The Grade 3 denominator. Without it a three-child hamlet school and a
--    sixty-child school produce the same percentage field.
alter table schools add column if not exists n_students integer;

-- 4b. The state profile the files were detected as, and the low-confidence
--     marker on a gap whose school has too few children to carry a finding.
alter table cycles add column if not exists detected_state_code text not null default 'MP';
alter table gaps add column if not exists low_sample jsonb;

-- 5. A shared phone. The chat id was globally unique, so the second officer on
--    a shared number could never be linked at all.
alter table contacts drop constraint if exists contacts_telegram_chat_id_key;
alter table contacts add column if not exists is_primary boolean not null default true;
alter table contacts add column if not exists linked_at timestamptz not null default now();
drop index if exists contacts_telegram_chat_id_key;
create index if not exists idx_contacts_chat on contacts (block_id, telegram_chat_id);
create unique index if not exists contacts_block_chat_uq on contacts (block_id, telegram_chat_id, person_id);

-- 6. More than one block for the DEO. Every table already carries block_id, so
--    the aggregate is a summary table written by the server.
create table if not exists district_blocks_summary (
  id bigint generated always as identity primary key,
  district_id text not null,
  block_id text not null,
  block_name text not null default '',
  cycle_id bigint,
  computed_at timestamptz not null default now(),
  schools integer not null default 0,
  gaps_total integer not null default 0,
  box_ticks integer not null default 0,
  closure_pct double precision,
  single_teacher_schools integer not null default 0,
  vacancy_aged integer not null default 0,
  avg_r3 double precision,
  detail jsonb not null default '{}'::jsonb,
  unique (district_id, block_id, cycle_id)
);

-- 7. Thresholds the SPD may change at runtime.
create table if not exists block_settings (
  block_id text primary key,
  thresholds jsonb not null default '{}'::jsonb,
  state_code text not null default 'MP',
  updated_by_role text not null default '',
  updated_by_person_id text not null default '',
  updated_at timestamptz not null default now()
);

-- 8. An inbound Telegram update is handled once, even if Telegram redelivers it.
create table if not exists inbound_webhook_dedup (
  update_id bigint primary key,
  block_id text not null default '',
  chat_id text,
  received_at timestamptz not null default now(),
  outcome text not null default ''
);

-- 8b. The last successful reorder for a cycle and list size. Asking for the same
--     list again in the same cycle serves the stored order and spends no tokens.
create table if not exists narrate_cache (
  id bigint generated always as identity primary key,
  block_id text not null,
  cycle_id bigint not null,
  list_limit int not null,
  gap_signature text not null,
  -- The reordered gaps. The column is not called "order": that is a reserved word.
  gap_order jsonb not null,
  laya_confidence double precision,
  model text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  created_at timestamptz not null default now(),
  unique (block_id, cycle_id, list_limit)
);
alter table narrate_cache enable row level security;
create policy beo_reads_own_block on narrate_cache for select using (block_id = samiksha_current_block());

-- 9. The scope assertion. Every transaction declares the block, the role, the
--    person and the cluster it acts as; this checks that the declaration and
--    the session agree.
create or replace function samiksha_assert_scope() returns void
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  declared_block text := nullif(current_setting('app.block_id', true), '');
  session_block text := samiksha_current_block();
begin
  if declared_block is null or session_block is null then
    return;
  end if;
  if declared_block <> session_block then
    raise exception 'SCOPE_FORBIDDEN: this transaction acts on block %, the session is bound to %', declared_block, session_block using errcode = '42501';
  end if;
end
$$;

-- 10. The task status log now records who acted and at which level.
create or replace function samiksha_log_task_status() returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  acting_role text := upper(nullif(current_setting('app.current_role', true), ''));
  acting_level integer := samiksha_role_level(current_setting('app.current_role', true));
  acting_person text := nullif(current_setting('app.current_person_id', true), '');
  overrode boolean := false;
  required_level integer := 3;
begin
  -- An approval needs level 3; anything above it is a supervisory override.
  if tg_op = 'UPDATE' and new.status = 'approved' and old.status is distinct from 'approved' then
    overrode := acting_level > required_level;
  end if;
  if tg_op = 'INSERT' then
    insert into task_events (block_id, cycle_id, task_id, task_no, from_status, to_status, acted_as_level, actor_person_id, is_supervisory_override)
    values (new.block_id, new.cycle_id, new.id, new.task_no, null, new.status, acting_level, acting_person, overrode);
  elsif new.status is distinct from old.status then
    insert into task_events (block_id, cycle_id, task_id, task_no, from_status, to_status, acted_as_level, actor_person_id, is_supervisory_override)
    values (new.block_id, new.cycle_id, new.id, new.task_no, old.status, new.status, acting_level, acting_person, overrode);
  end if;
  return new;
end
$$;

-- 11. The role guard writes the level it checked, so the audit trail can show it.
create or replace function samiksha_task_role_guard() returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  r text := upper(nullif(current_setting('app.current_role', true), ''));
  prev text := null;
  lvl integer := samiksha_role_level(current_setting('app.current_role', true));
begin
  if r is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    prev := old.status;
  end if;
  if new.status = 'approved' and prev is distinct from 'approved' and lvl < 3 then
    raise exception 'ROLE_FORBIDDEN: approving a task needs level 3 (BEO) or above (role %)', r using errcode = '42501';
  end if;
  if new.action_id = 'vacancy' and new.status = 'done' and prev is distinct from 'done' and lvl < 4 then
    raise exception 'ROLE_FORBIDDEN: closing a vacancy needs level 4 (DEO) or above (role %)', r using errcode = '42501';
  end if;
  return new;
end
$$;

-- 12. The same read rule as the other tables (0003_rls.sql): a BEO sees only their block.
alter table officer_session_log enable row level security;
create policy beo_reads_own_block on officer_session_log for select using (block_id = samiksha_current_block());

alter table block_settings enable row level security;
create policy beo_reads_own_block on block_settings for select using (block_id = samiksha_current_block());

alter table inbound_webhook_dedup enable row level security;
create policy beo_reads_own_block on inbound_webhook_dedup for select using (block_id = samiksha_current_block());

alter table district_blocks_summary enable row level security;
create policy beo_reads_own_block on district_blocks_summary for select using (block_id = samiksha_current_block());

-- 13. The outbound rate window. One row per second, shared by every worker.
--     Two workers that pick the same message cannot both deliver it (the claim
--     is one atomic statement), and the 25-a-second limit holds across
--     processes, not just inside one.
create table if not exists queue_rate_window (
  window_second bigint primary key,
  sent int not null default 0
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on officer_session_log to authenticated;
    grant select on block_settings to authenticated;
    grant select on inbound_webhook_dedup to authenticated;
    grant select on district_blocks_summary to authenticated;
  end if;
end
$$;
