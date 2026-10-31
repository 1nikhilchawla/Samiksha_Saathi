-- Every task status change, append-only: who moved a task from what to what, and when.
-- A trigger writes it, so web actions, bot commands, field replies, nudges and the
-- overdue sweep are all logged without each code path remembering to.

create table if not exists task_events (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  client_request_id uuid not null default gen_random_uuid(),
  cycle_id bigint not null references cycles (id) on delete cascade,
  task_id bigint references tasks (id) on delete set null,
  task_no integer not null,
  from_status text,
  to_status text not null
);
create unique index if not exists task_events_block_request_uq on task_events (block_id, client_request_id);
create index if not exists task_events_task_idx on task_events (cycle_id, task_no, id);

create or replace function samiksha_log_task_status() returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    insert into task_events (block_id, cycle_id, task_id, task_no, from_status, to_status)
    values (new.block_id, new.cycle_id, new.id, new.task_no, null, new.status);
  elsif new.status is distinct from old.status then
    insert into task_events (block_id, cycle_id, task_id, task_no, from_status, to_status)
    values (new.block_id, new.cycle_id, new.id, new.task_no, old.status, new.status);
  end if;
  return new;
end
$$;

drop trigger if exists tasks_status_log on tasks;
create trigger tasks_status_log after insert or update of status on tasks
  for each row execute function samiksha_log_task_status();

-- Same read rule as the other tables (0003_rls.sql): a BEO sees only their block.
alter table task_events enable row level security;
create policy beo_reads_own_block on task_events for select using (block_id = samiksha_current_block());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on task_events to authenticated;
  end if;
end
$$;
