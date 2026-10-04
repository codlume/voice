ALTER TABLE `parent` DROP COLUMN `body`;
ALTER TABLE `parent` ADD COLUMN `body` text NOT NULL DEFAULT '';
