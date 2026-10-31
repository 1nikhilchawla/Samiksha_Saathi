-- Samiksha Saathi: durable review cycle, tasks, bot messages, scorecards, model ledger.
--
-- Every table carries block_id, created_at and client_request_id. The unique
-- (block_id, client_request_id) index makes every write idempotent: the server
-- derives client_request_id deterministically (request id + row key, or the
-- Telegram update_id), so a retried request hits `on conflict do nothing`.
--
-- Applied to Postgres (Supabase / any DATABASE_URL) by scripts/migrate.mjs on
-- build, and to the PGlite dev/test database on startup by src/lib/db.ts.

create table if not exists cycles (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  source text not null check (source in ('seed', 'upload')),
  review_date date not null,
  -- The cycle clock. Synthetic cycles run on review dates; null = real IST today.
  sim_today date,
  prep_seconds double precision not null,
  runtime_s double precision not null,
  r4_loaded boolean not null default false,
  summary jsonb not null,
  peer jsonb not null,
  peers jsonb not null,
  flags jsonb not null,
  header_maps jsonb not null,
  files jsonb not null,
  r4_files jsonb not null,
  people jsonb not null,
  brief_input jsonb not null,
  brief_en text not null,
  brief_hi text not null,
  contract_errors jsonb not null
);
create unique index if not exists cycles_block_request_uq on cycles (block_id, client_request_id);
create index if not exists cycles_block_latest_idx on cycles (block_id, id desc);

create table if not exists schools (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  code text not null,
  name_en text not null,
  name_hi text not null,
  cluster text not null,
  working_teachers integer not null,
  maths_post text not null,
  vacant_since text not null,
  y1 double precision,
  y2 double precision,
  r1 double precision,
  r2 double precision,
  r3 double precision,
  r4 double precision,
  jul_aug double precision,
  oct_nov double precision,
  dec_att double precision,
  days_since_visit integer,
  last_visit text not null,
  last_note text not null,
  kind text not null,
  unique (cycle_id, code)
);
create unique index if not exists schools_block_request_uq on schools (block_id, client_request_id);

create table if not exists issues (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  seq integer not null,
  category text not null check (category in ('data_problem', 'auto_fixed')),
  severity text not null,
  issue_type text not null,
  school_code text not null,
  raw_value text not null,
  fixed_value text not null,
  source_file text not null,
  source_row integer not null,
  description_en text not null,
  description_hi text not null
);
create unique index if not exists issues_block_request_uq on issues (block_id, client_request_id);
create index if not exists issues_cycle_idx on issues (cycle_id, seq);

create table if not exists gaps (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  gap_id text not null,
  code_rank integer not null,
  claude_rank integer not null,
  rank_justification_en text not null,
  rank_justification_hi text not null,
  target_label text not null,
  target_label_hi text not null,
  target_type text not null,
  target_codes jsonb not null,
  gap_kind text not null,
  fact_en text not null,
  fact_hi text not null,
  reason_en text not null,
  reason_hi text not null,
  action_id text not null,
  allowed_actions jsonb not null,
  source_refs jsonb not null,
  code_score integer not null,
  unique (cycle_id, gap_id)
);
create unique index if not exists gaps_block_request_uq on gaps (block_id, client_request_id);

create table if not exists tasks (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  task_no integer not null,
  gap_id text not null,
  action_id text not null,
  what_en text not null,
  what_hi text not null,
  owner_id text,
  target_label text not null,
  target_label_hi text not null,
  target_codes jsonb not null,
  due_date date,
  success_en text not null,
  success_hi text not null,
  status text not null check (status in (
    'draft', 'approved', 'rejected', 'sent', 'reminded', 'done', 'partial',
    'blocked', 'overdue', 'escalated', 'outcome_checked', 'cancelled')),
  missing_fields jsonb not null default '[]',
  approved_by text,
  approved_at timestamptz,
  completed_at date,
  units_done integer not null default 0 check (units_done >= 0),
  note text not null default '',
  note_hi text not null default '',
  updated_at timestamptz not null default now(),
  unique (cycle_id, task_no),
  -- Guardrail (c), enforced by the database too: nothing past draft/rejected
  -- exists without an owner, a due date and a success measure.
  constraint tasks_dispatchable check (
    status in ('draft', 'rejected', 'cancelled')
    or (owner_id is not null and due_date is not null and btrim(success_en) <> '')
  )
);
create unique index if not exists tasks_block_request_uq on tasks (block_id, client_request_id);
create index if not exists tasks_due_idx on tasks (block_id, due_date, status);

-- The only thing the outbound bot reads (guardrail c).
create or replace view outbound_queue as
  select * from tasks
  where status = 'approved'
    and approved_by is not null
    and owner_id is not null
    and due_date is not null
    and btrim(success_en) <> '';

create table if not exists messages (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint references cycles (id) on delete cascade,
  task_id bigint references tasks (id) on delete set null,
  direction text not null check (direction in ('in', 'out', 'sys')),
  kind text not null check (kind in ('card', 'nudge', 'reply', 'system', 'command')),
  channel text not null check (channel in ('telegram', 'web')),
  person_id text,
  chat_id text,
  text text not null,
  parsed jsonb,
  parse_source text
);
create unique index if not exists messages_block_request_uq on messages (block_id, client_request_id);
create index if not exists messages_cycle_idx on messages (cycle_id, id);
create index if not exists messages_daily_idx on messages (block_id, created_at) where direction = 'out';

create table if not exists scorecard_snapshots (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint not null references cycles (id) on delete cascade,
  approved integer not null,
  closed_on_time integer not null,
  closure_pct double precision not null,
  data jsonb not null
);
create unique index if not exists scorecard_block_request_uq on scorecard_snapshots (block_id, client_request_id);
create index if not exists scorecard_cycle_idx on scorecard_snapshots (cycle_id, id desc);

create table if not exists llm_calls (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  cycle_id bigint references cycles (id) on delete cascade,
  purpose text not null,
  model text not null,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  inr double precision not null default 0,
  passed boolean not null,
  simulated boolean not null,
  billable boolean not null default false,
  note text not null default '',
  detail jsonb
);
create unique index if not exists llm_calls_block_request_uq on llm_calls (block_id, client_request_id);
create index if not exists llm_calls_budget_idx on llm_calls (block_id, purpose, created_at) where billable;

-- Who a Telegram chat is. Linked by the BEO (/link), never self-claimed.
create table if not exists contacts (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null,
  person_id text not null,
  telegram_chat_id text not null unique,
  unique (block_id, person_id)
);
create unique index if not exists contacts_block_request_uq on contacts (block_id, client_request_id);
