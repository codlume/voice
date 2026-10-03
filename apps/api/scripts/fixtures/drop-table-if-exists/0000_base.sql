CREATE TABLE `note` (`id` text PRIMARY KEY NOT NULL, `body` text NOT NULL);
CREATE TABLE `parent` (`id` text PRIMARY KEY NOT NULL, `body` text NOT NULL DEFAULT '');
CREATE TABLE `child` (`id` text PRIMARY KEY NOT NULL, `parent_id` text NOT NULL REFERENCES `parent`(`id`) ON DELETE CASCADE);
CREATE TABLE `sqliteX` (`id` text PRIMARY KEY NOT NULL);
CREATE TABLE `measure` (`value` integer NOT NULL, `doubled` integer GENERATED ALWAYS AS (`value` * 2) VIRTUAL);
CREATE TABLE `tag` (`id` text PRIMARY KEY NOT NULL, `label` text NOT NULL);
CREATE INDEX `tag_label_idx` ON `tag` (`label`);
CREATE VIEW `tag_labels` AS SELECT `label` FROM `tag`;
CREATE TRIGGER `tag_touch` AFTER UPDATE ON `tag` BEGIN SELECT 1; END;
