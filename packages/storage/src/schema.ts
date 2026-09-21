import { sqliteTable, text, integer, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const preferences = sqliteTable(
  "preferences",
  {
    id: integer().primaryKey(),
    appearance: text({ enum: ["light", "dark"] }).notNull(),
  },
  (table) => [
    check("singleton", sql`${table.id} = 1`),
    check("appearance", sql`${table.appearance} in ('light', 'dark')`),
  ],
);
