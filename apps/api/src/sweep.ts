import { and, eq, inArray, lt, notExists } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema.ts";

// D1 has no interactive transactions, so a first sign-in writes the user row and then the account
// row, and a deletion removes the account rows and then the user row. D1 failing in between leaves
// a user row with no account, and with linking off every later Google sign-in for that email ends
// in account_not_linked until the row is gone. The grace period spares a first sign-in still
// between its writes: createdAt is stamped before the user insert, D1 gives up on a statement
// after 30 s, and the work between the two inserts takes milliseconds.
const userWithoutAccountGraceMs = 60_000;

const deletesPerRulePerRun = 1000;

export async function sweep(env: Env) {
  const db = drizzle(env.DB, { schema });
  const now = new Date();
  const rules = {
    usersWithoutAccount: () =>
      db.delete(schema.user).where(
        inArray(
          schema.user.id,
          db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(
              and(
                lt(schema.user.createdAt, new Date(now.getTime() - userWithoutAccountGraceMs)),
                notExists(
                  db.select().from(schema.account).where(eq(schema.account.userId, schema.user.id)),
                ),
              ),
            )
            .limit(deletesPerRulePerRun),
        ),
      ),
    // Better Auth deletes an expired session only when its own token comes back, and a session
    // from a wiped or lost machine never does.
    expiredSessions: () =>
      db
        .delete(schema.session)
        .where(
          inArray(
            schema.session.id,
            db
              .select({ id: schema.session.id })
              .from(schema.session)
              .where(lt(schema.session.expiresAt, now))
              .limit(deletesPerRulePerRun),
          ),
        ),
  };
  for (const [rule, run] of Object.entries(rules)) {
    try {
      const { meta } = await run();
      console.log(JSON.stringify({ source: "sweep", rule, deleted: meta.changes }));
    } catch {
      console.error(JSON.stringify({ source: "sweep", rule, level: "error" }));
    }
  }
}
