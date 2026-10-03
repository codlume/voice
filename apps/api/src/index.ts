import { Hono } from "hono";
import { createAuth, type Env } from "./auth";

type SpikeEnv = Env & { AUTH_INIT?: "lazy" | "lazy-waituntil" };

let auth: ReturnType<typeof createAuth> | undefined;

const app = new Hono<{ Bindings: SpikeEnv }>();

app.get("/health", (c) => c.json({ ok: true }));

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  if (!auth) {
    auth = createAuth(c.env);
    if (c.env.AUTH_INIT === "lazy-waituntil") c.executionCtx.waitUntil(auth.$context);
  }
  return auth.handler(c.req.raw);
});

export default app;
