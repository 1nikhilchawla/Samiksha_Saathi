-- System lines (escalations, balance-check refusals) carry both languages so
-- the Follow tab can switch them with the language toggle.
alter table messages add column if not exists text_copy jsonb;
