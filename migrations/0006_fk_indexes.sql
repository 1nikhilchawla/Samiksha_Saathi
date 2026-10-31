-- Covering indexes for foreign keys the Supabase linter flagged (0001_unindexed_foreign_keys):
-- replacing drafts deletes task rows, which must find their messages and events quickly.
create index if not exists llm_calls_cycle_idx on llm_calls (cycle_id);
create index if not exists messages_task_idx on messages (task_id);
create index if not exists task_events_task_id_idx on task_events (task_id);
