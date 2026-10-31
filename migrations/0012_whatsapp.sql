-- 0012: WhatsApp field replies.
--
-- A WhatsApp reply arrives from a phone number, so the number has to point at a
-- roster person before the reply can move a task. The BEO links it when a task
-- card is first sent to that number; nobody can claim a number for themselves.
-- Replies are stored in messages like Telegram ones, on their own channel.

create table if not exists whatsapp_contacts (
  id bigint generated always as identity primary key,
  block_id text not null,
  created_at timestamptz not null default now(),
  person_id text not null,
  phone text not null unique check (phone ~ '^[0-9]{10,15}$'),
  linked_by_role text not null check (linked_by_role in ('BEO', 'DEO', 'SPD')),
  unique (block_id, person_id)
);
alter table whatsapp_contacts enable row level security;
create policy beo_reads_own_block on whatsapp_contacts for select using (block_id = samiksha_current_block());

alter table messages drop constraint if exists messages_channel_check;
alter table messages add constraint messages_channel_check check (channel in ('telegram', 'web', 'whatsapp'));
