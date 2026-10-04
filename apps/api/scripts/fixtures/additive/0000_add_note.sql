CREATE TABLE `note` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `note` ADD `archived_at` integer;
