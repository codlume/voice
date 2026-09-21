import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";
import type { SetupPreferences } from "@voice/contracts/setup";
import { sql } from "drizzle-orm";

export const preferences = sqliteTable(
  "preferences",
  {
    id: integer().primaryKey(),
    setup: text({ mode: "json" }).$type<SetupPreferences>(),
    appearance: text({ enum: ["light", "dark"] }).notNull(),
  },
  (table) => [
    check("singleton", sql`${table.id} = 1`),
    check("appearance", sql`${table.appearance} in ('light', 'dark')`),
  ],
);
