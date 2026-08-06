-- rate_limits gains the index its sweep ranges over.
--
-- Counting an event is a primary-key upsert and needs nothing more. The other
-- statement in server/ratelimit.ts is `delete from rate_limits where
-- window_start < ?`, which without this scans every counter in the service —
-- and gets slower exactly as the table grows, which is to say exactly when an
-- unauthenticated caller is filling it with one row per address it invents.
CREATE INDEX `rate_limits_window_start_idx` ON `rate_limits` (`window_start`);
