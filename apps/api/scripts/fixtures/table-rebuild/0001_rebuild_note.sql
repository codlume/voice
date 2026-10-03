CREATE TABLE `__new_note` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL DEFAULT ''
);
--> statement-breakpoint
INSERT INTO `__new_note`("id", "body") SELECT "id", "body" FROM `note`;
--> statement-breakpoint
DROP TABLE `note`;
--> statement-breakpoint
ALTER TABLE `__new_note` RENAME TO `note`;
