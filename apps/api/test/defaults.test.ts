import { env } from "cloudflare:test";
import { betterAuth } from "better-auth";
import { expect, it } from "vite-plus/test";
import { createAuth } from "../src/auth";

it("leaves rate limiting off on Workers unless it is enabled explicitly", async () => {
  const implicit = betterAuth({ baseURL: "http://localhost:8787", secret: env.BETTER_AUTH_SECRET });
  expect(globalThis.process?.env?.NODE_ENV).toBeUndefined();
  expect((await implicit.$context).rateLimit.enabled).toBe(false);
  const explicit = createAuth(env);
  expect((await explicit.$context).rateLimit).toMatchObject({ enabled: true, storage: "database" });
});
