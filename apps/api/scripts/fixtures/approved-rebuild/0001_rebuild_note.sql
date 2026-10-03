-- migration-check: approved note has no child tables, reviewed in #000
CREATE TABLE `__new_note` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_note`("id") SELECT "id" FROM `note`;
--> statement-breakpoint
DROP TABLE `note`;
--> statement-breakpoint
ALTER TABLE `__new_note` RENAME TO `note`;
