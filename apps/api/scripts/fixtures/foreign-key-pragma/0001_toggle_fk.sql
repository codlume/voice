PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `note` ADD `owner_id` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
