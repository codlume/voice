import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";

const clearIdTokens = "0001_clear_id_tokens.sql";
const row = () =>
  env.DB.prepare("select access_token, id_token from account where id = 'old-account'").first();

it("0001 clears ID tokens stored before the account hooks, and changes nothing when run again (catches plain ID tokens left in D1 after deploy)", async () => {
  // Roll the database back to the previous migration set, holding a row as the old code wrote it.
  await env.DB.prepare("delete from d1_migrations where name = ?").bind(clearIdTokens).run();
  await env.DB.batch([
    env.DB.prepare(
      "insert into user (id, name, email) values ('old-user', 'Old', 'old@example.com')",
    ),
    env.DB.prepare(
      "insert into account (id, account_id, provider_id, user_id, access_token, id_token, updated_at) values ('old-account', 'google-old', 'google', 'old-user', 'ciphertext', 'header.claims.signature', 0)",
    ),
  ]);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  expect(await row()).toEqual({ access_token: "ciphertext", id_token: null });

  const migration = env.TEST_MIGRATIONS.find(({ name }) => name === clearIdTokens);
  await env.DB.batch(migration?.queries.map((query) => env.DB.prepare(query)) ?? []);
  expect(await row()).toEqual({ access_token: "ciphertext", id_token: null });
});

it("0002 lets a Google sign-in find its account by provider and account id through an index (catches a dropped index, where every sign-in scans the whole account table)", async () => {
  const plan = await env.DB.prepare(
    "explain query plan select id from account where provider_id = ? and account_id = ?",
  )
    .bind("google", "subject")
    .all<{ detail: string }>();

  expect(plan.results.map(({ detail }) => detail)).toEqual([
    expect.stringMatching(/^SEARCH account USING INDEX \w+ \(provider_id=\? AND account_id=\?\)$/),
  ]);
});
