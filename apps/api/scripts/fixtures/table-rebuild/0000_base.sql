CREATE TABLE `note` (`id` text PRIMARY KEY NOT NULL, `body` text NOT NULL);
CREATE TABLE `parent` (`id` text PRIMARY KEY NOT NULL, `body` text NOT NULL DEFAULT '');
CREATE TABLE `child` (`id` text PRIMARY KEY NOT NULL, `parent_id` text NOT NULL REFERENCES `parent`(`id`) ON DELETE CASCADE);
