-- Queue, stored proof, rewards, to-dos and failure log; cumulative role levels.
--
-- 1. message_queue: every proactive Telegram message, fact-checked and keyed by
--    client_request_id (the idempotency key), delivered by the queue worker
--    within Telegram's rate limits, retried with backoff, dead-lettered after
--    5 attempts.
-- 2. encrypted_media_proofs: the blurred, compressed classroom photo only
--    (45 KB at most), AES-256-GCM encrypted with a server key. The unblurred
--    original is never stored.
-- 3. worker_rewards_ledger, officer_todos, failure_diagnostics_log.
-- 4. The tasks role guard (0007) becomes level-based: level 3 (BEO) and above
--    approve; level 4 (DEO) and above close a vacancy.
-- RLS as in 0003/0007: block isolation, CRCC/HM narrowed to their own rows, no
-- write policies (direct client writes stay denied). Plain Postgres for PGlite.

create table if not exists message_queue (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint references cycles (id) on delete cascade,
  task_id bigint references tasks (id) on delete set null,
  task_no integer,
  kind text not null check (kind in ('task_card', 'nudge', 'weekly_digest', 'deo_escalation', 'appreciation', 'why_diagnostic', 'system_reply')),
  priority smallint not null check (priority between 1 and 4),
  person_id text,
  chat_id text,
  text text not null,
  text_copy jsonb,
  fact_check jsonb not null,
  status text not null check (status in ('queued', 'processing', 'delivered', 'retry_scheduled', 'blocked_fact_check', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  channel text not null default 'telegram' check (channel in ('telegram', 'web')),
  delivered_at timestamptz
);
create unique index if not exists message_queue_block_request_uq on message_queue (block_id, client_request_id);
create index if not exists message_queue_due_idx on message_queue (status, next_attempt_at, priority);
create index if not exists message_queue_chat_idx on message_queue (chat_id, delivered_at);
create index if not exists message_queue_task_idx on message_queue (task_id);
create index if not exists message_queue_cycle_idx on message_queue (cycle_id);

create table if not exists encrypted_media_proofs (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  task_no integer,
  school_code text,
  mime text not null check (mime in ('image/webp', 'image/jpeg')),
  original_bytes integer not null check (original_bytes >= 0),
  compressed_bytes integer not null check (compressed_bytes between 1 and 46080),
  width integer not null,
  height integer not null,
  iv_hex text not null,
  cipher_b64 text not null,
  min_role_level smallint not null default 3,
  decision_code text not null,
  decision_confidence real not null,
  person_count integer not null,
  consent_tier1_by text not null check (consent_tier1_by in ('HM', 'CRCC', 'BEO', 'DEO', 'SPD')),
  consent_tier2_by text check (consent_tier2_by in ('BEO', 'DEO', 'SPD')),
  consent_tier3_by text check (consent_tier3_by in ('DEO', 'SPD'))
);
create unique index if not exists encrypted_media_proofs_block_request_uq on encrypted_media_proofs (block_id, client_request_id);
create index if not exists encrypted_media_proofs_cycle_idx on encrypted_media_proofs (cycle_id, id);

create table if not exists worker_rewards_ledger (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  person_id text not null,
  points integer not null check (points >= 0),
  badges jsonb not null default '[]',
  reasons jsonb not null,
  awarded_by_role text not null check (awarded_by_role in ('BEO', 'DEO', 'SPD')),
  queue_id bigint references message_queue (id) on delete set null
);
create unique index if not exists worker_rewards_block_request_uq on worker_rewards_ledger (block_id, client_request_id);
create index if not exists worker_rewards_cycle_idx on worker_rewards_ledger (cycle_id, person_id);
create index if not exists worker_rewards_queue_idx on worker_rewards_ledger (queue_id);

create table if not exists officer_todos (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  officer_role text not null check (officer_role in ('HM', 'CRCC', 'BEO', 'DEO', 'SPD')),
  text text not null check (char_length(text) between 1 and 200),
  done boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index if not exists officer_todos_block_request_uq on officer_todos (block_id, client_request_id);
create index if not exists officer_todos_role_idx on officer_todos (block_id, officer_role);

create table if not exists failure_diagnostics_log (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint references cycles (id) on delete cascade,
  surface text not null,
  failure_code text not null,
  person_id text,
  confidence real not null,
  gate_source text not null check (gate_source in ('rules', 'laya')),
  facts jsonb not null,
  why_failed jsonb not null,
  how_to_fix jsonb not null,
  explained_by text not null default 'rules' check (explained_by in ('rules', 'model'))
);
create unique index if not exists failure_diagnostics_block_request_uq on failure_diagnostics_log (block_id, client_request_id);
create index if not exists failure_diagnostics_recent_idx on failure_diagnostics_log (block_id, id desc);
create index if not exists failure_diagnostics_cycle_idx on failure_diagnostics_log (cycle_id);

-- 4. Cumulative levels in the tasks role guard.
create or replace function samiksha_role_level(r text) returns integer
language sql immutable
set search_path = pg_catalog
as $$
  select case upper(coalesce(r, '')) when 'HM' then 1 when 'CRCC' then 2 when 'BEO' then 3 when 'DEO' then 4 when 'SPD' then 5 else 0 end
$$;

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
  if new.status = 'approved' and prev is distinct from 'approved' and samiksha_role_level(r) < 3 then
    raise exception 'ROLE_FORBIDDEN: approving a task needs level 3 (BEO) or above (role %)', r using errcode = '42501';
  end if;
  if new.action_id = 'vacancy' and new.status = 'done' and prev is distinct from 'done' and samiksha_role_level(r) < 4 then
    raise exception 'ROLE_FORBIDDEN: closing a vacancy needs level 4 (DEO) or above (role %)', r using errcode = '42501';
  end if;
  return new;
end
$$;

-- RLS: block isolation, then CRCC/HM narrowed to their own rows.
alter table message_queue enable row level security;
alter table encrypted_media_proofs enable row level security;
alter table worker_rewards_ledger enable row level security;
alter table officer_todos enable row level security;
alter table failure_diagnostics_log enable row level security;

create policy beo_reads_own_block on message_queue for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on encrypted_media_proofs for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on worker_rewards_ledger for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on officer_todos for select using (block_id = samiksha_current_block());
create policy beo_reads_own_block on failure_diagnostics_log for select using (block_id = samiksha_current_block());

create policy role_limits_message_queue on message_queue as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM') or person_id = samiksha_current_person()
);
-- Encrypted proofs: below level 3 nobody reads the rows at all.
create policy role_limits_media_proofs on encrypted_media_proofs as restrictive for select using (
  samiksha_role_level(coalesce(samiksha_current_role(), 'BEO')) >= 3
);
create policy role_limits_worker_rewards on worker_rewards_ledger as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM') or person_id = samiksha_current_person()
);
create policy role_limits_officer_todos on officer_todos as restrictive for select using (
  officer_role = coalesce(samiksha_current_role(), officer_role)
);
create policy role_limits_failure_log on failure_diagnostics_log as restrictive for select using (
  coalesce(samiksha_current_role(), 'BEO') not in ('CRCC', 'HM') or person_id = samiksha_current_person()
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on message_queue, encrypted_media_proofs, worker_rewards_ledger, officer_todos, failure_diagnostics_log to authenticated;
  end if;
end
$$;
