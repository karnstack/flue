-- device_auth gains the daemon's label.
--
-- `devices.label` is NOT NULL and the device row is not written until the
-- approving poll, so the name `flue link` gives itself has to survive from
-- the daemon's first request to the browser's confirmation and on to the
-- device row — three requests, one table. It is also what the person approving
-- reads: a code alone says nothing about which machine is asking.
--
-- Written by hand rather than left as drizzle-kit's `ALTER TABLE ... ADD label
-- text NOT NULL`, which SQLite refuses outright: a NOT NULL column added to an
-- existing table must carry a non-NULL default, and giving `label` a default of
-- '' would leave the schema claiming something the application never writes.
--
-- Dropping the table is safe here in a way it would not be for any other table
-- in this database: a device_auth row is a ten-minute, single-use grant that is
-- deleted the moment it is spent. The worst this can do is make an enrolment
-- that was in flight at deploy time answer "expired", and `flue link` starts
-- a new one.
DROP TABLE `device_auth`;--> statement-breakpoint
CREATE TABLE `device_auth` (
	`user_code` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_user_id` text,
	`device_id` text,
	`public_key` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_auth_device_code_idx` ON `device_auth` (`device_code`);
