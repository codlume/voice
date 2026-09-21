CREATE TABLE `preferences` (
	`id` integer PRIMARY KEY,
	`appearance` text NOT NULL,
	CONSTRAINT "singleton" CHECK("id" = 1),
	CONSTRAINT "appearance" CHECK("appearance" in ('light', 'dark'))
);
