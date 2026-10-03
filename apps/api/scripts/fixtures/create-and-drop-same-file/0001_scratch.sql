CREATE TABLE `scratch` (`id` text PRIMARY KEY NOT NULL);
CREATE INDEX `scratch_id_idx` ON `scratch` (`id`);
DROP INDEX `scratch_id_idx`;
DROP TABLE `scratch`;
