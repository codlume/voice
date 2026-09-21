import { Effect, ManagedRuntime } from "effect";
import * as Sqlite from "@effect/sql-sqlite-node/SqliteClient";
import * as Drizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { decodeSettings, defaultSettings, type Settings } from "@voice/contracts/desktop";
import { preferences } from "./schema";

export async function openSettings(options: { filename: string; migrations: string }) {
  const runtime = ManagedRuntime.make(Sqlite.layer({ filename: options.filename }));
  try {
    const db = await runtime.runPromise(Drizzle.makeWithDefaults());
    await runtime.runPromise(migrate(db, { migrationsFolder: options.migrations }));
    const get = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const rows = yield* db
            .select({ appearance: preferences.appearance, setup: preferences.setup })
            .from(preferences);
          const row = rows[0];
          return decodeSettings(
            row
              ? { appearance: row.appearance, ...(row.setup ? { setup: row.setup } : {}) }
              : defaultSettings,
          );
        }),
      );
    return {
      get,
      async set(input: Settings) {
        const settings = decodeSettings(input);
        await runtime.runPromise(
          db
            .insert(preferences)
            .values({ id: 1, ...settings })
            .onConflictDoUpdate({ target: preferences.id, set: settings }),
        );
        return get();
      },
      close: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
