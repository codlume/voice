import { Hono } from "hono";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { createAuth } from "./auth.ts";
import { landingCsp, landingPage } from "./landing.ts";

const everyResponse = {
  strictTransportSecurity: "max-age=63072000; includeSubDomains",
  xFrameOptions: "DENY",
};
const securityHeaders = secureHeaders({
  ...everyResponse,
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
});
const landingHeaders = secureHeaders({ ...everyResponse, contentSecurityPolicy: landingCsp });

const app = new Hono<{ Bindings: Env; Variables: RequestIdVariables }>();

// secureHeaders writes its headers after next(), so the policy is picked per route here.
app.use((c, next) => (c.req.path === "/" ? landingHeaders : securityHeaders)(c, next));
// An empty header name keeps a client from choosing the id. It also stops Hono from
// echoing it, so onError returns it explicitly for error reports.
app.use(requestId({ headerName: "" }));

app.get("/health", (c) => c.body(null, 200));

app.get("/", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(landingPage);
});

let auth: ReturnType<typeof createAuth> | undefined;
app.on(["GET", "POST"], "/api/auth/*", (c) => {
  if (!auth) {
    auth = createAuth(c.env);
    // A lazy instance ties its setup to the first request; keep it alive if that request is aborted (better-auth#10315).
    c.executionCtx.waitUntil(auth.$context);
  }
  return auth.handler(c.req.raw);
});

app.onError(async (error, c) => {
  const id = c.get("requestId");
  console.error(
    JSON.stringify({
      requestId: id,
      route: routePath(c),
      status: 500,
      error: error.name,
    }),
  );
  // While securityHeaders is the first middleware, every error response already
  // passes through it. This keeps error responses covered if that order changes.
  await securityHeaders(c, async () => {
    c.res = c.json({ error: "Internal Server Error" }, 500, { "X-Request-Id": id });
  });
  return c.res;
});

export default app;
