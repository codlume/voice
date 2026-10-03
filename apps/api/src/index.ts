import { env as moduleEnv } from "cloudflare:workers";
import { Hono } from "hono";
import { createAuth, type Env } from "./auth";
import { installFakeGoogle } from "./fake-google";

type SpikeEnv = Env & { AUTH_INIT?: "lazy" | "lazy-waituntil" | "global"; FAKE_GOOGLE?: string };

let auth: ReturnType<typeof createAuth> | undefined =
  (moduleEnv as SpikeEnv).AUTH_INIT === "global" ? createAuth(moduleEnv as SpikeEnv) : undefined;

const app = new Hono<{ Bindings: SpikeEnv }>();

app.get("/health", (c) => c.json({ ok: true }));

// Spike only: a loopback request that is cancelled mid-flight, standing in for a client
// disconnect, because local workerd keeps running a request after curl goes away.
app.get("/spike/cancel-first", async (c) => {
  const ms = Number(c.req.query("ms") ?? "1");
  const controller = new AbortController();
  const pending = (c.executionCtx as unknown as { exports: { default: Fetcher } }).exports.default
    .fetch("http://localhost/api/auth/get-session", { signal: controller.signal })
    .then(
      (r) => `settled ${r.status}`,
      (e: Error) => `rejected ${e.name}`,
    );
  await scheduler.wait(ms);
  controller.abort();
  return c.json({ initialisedBefore: Boolean(auth), outcome: await pending });
});

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  if (!auth) {
    if (c.env.FAKE_GOOGLE === "1") installFakeGoogle(c.env.GOOGLE_CLIENT_ID);
    auth = createAuth(c.env);
    if (c.env.AUTH_INIT === "lazy-waituntil") c.executionCtx.waitUntil(auth.$context);
  }
  return auth.handler(c.req.raw);
});

export default app;
