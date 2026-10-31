-- 0011: the thresholds a cycle was built with.
--
-- The SPD can change a block's thresholds (block_settings, 0009). The pipeline
-- reads them when it builds a cycle, and the cycle keeps the values it used, so
-- the brief, the upload ledger and the hinge points describe the same rules.
-- Older cycles have none and fall back to CONFIG.

alter table cycles add column if not exists thresholds jsonb;
