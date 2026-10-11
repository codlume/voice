ALTER TABLE `user` ADD `first_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `last_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Splits each existing name as splitName in src/auth.ts does: the first word is the first name and
-- the rest the last name. Only rows without a first name change, so a rerun keeps edited names.
UPDATE `user` SET
  `first_name` = CASE
    WHEN instr(trim(`name`), ' ') = 0 THEN trim(`name`)
    ELSE substr(trim(`name`), 1, instr(trim(`name`), ' ') - 1)
  END,
  `last_name` = CASE
    WHEN instr(trim(`name`), ' ') = 0 THEN ''
    ELSE trim(substr(trim(`name`), instr(trim(`name`), ' ') + 1))
  END
WHERE `first_name` = '';--> statement-breakpoint
-- `name` is derived from the two from now on.
UPDATE `user` SET `name` = trim(`first_name` || ' ' || `last_name`);
