ALTER TABLE `user` ADD `first_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `last_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
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
UPDATE `user` SET `name` = trim(`first_name` || ' ' || `last_name`);
