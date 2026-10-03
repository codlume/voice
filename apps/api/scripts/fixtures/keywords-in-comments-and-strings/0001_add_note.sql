-- Never DROP TABLE note here; see PRAGMA foreign_keys in the docs.
/* ALTER TABLE note RENAME TO old_note is a rebuild. */
ALTER TABLE `note` ADD `hint` text DEFAULT 'drop table -- is not run';
