import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, it } from "vite-plus/test";

it("applies the committed migrations to local D1", async () => {
  const { results } = await env.DB.prepare(
    "select name from sqlite_master where type = 'table' and name not like '\\_%' escape '\\' and name not like 'sqlite%' and name != 'd1_migrations' order by name",
  ).all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual([
    "account",
    "rate_limit",
    "session",
    "user",
    "verification",
  ]);
});

it("serves the Worker inside workerd", async () => {
  const res = await exports.default.fetch("http://localhost:8787/health");
  expect(await res.json()).toEqual({ ok: true });
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
});
