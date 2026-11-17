-- The AI metadata proposal is gone (#69): nothing reads or writes the two AI
-- counters of usage_daily any more, and they only ever held zeros in
-- production. Drop them so the table matches what the server keeps.
ALTER TABLE usage_daily DROP COLUMN IF EXISTS ai_calls;
ALTER TABLE usage_daily DROP COLUMN IF EXISTS ai_microusd;
