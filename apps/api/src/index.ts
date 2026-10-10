import { waitUntil } from "cloudflare:workers";
import { Hono } from "hono";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";
import { authOptions, createAuth } from "./auth.ts";
import { landingCsp, landingPage } from "./landing.ts";
import { sweep } from "./sweep.ts";

const everyResponse = {
  strictTransportSecurity: "max-age=63072000; includeSubDomains",
  xFrameOptions: "DENY",
};
const securityHeaders = secureHeaders({
  ...everyResponse,
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
});
const landingHeaders = secureHeaders({ ...everyResponse, contentSecurityPolicy: landingCsp });

export const app = new Hono<{ Bindings: Env; Variables: RequestIdVariables }>({
  // The raw pathname, not Hono's decoded one, so routes match the string Better Auth keys on.
  getPath: (request) => new URL(request.url).pathname,
});

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

// Better Auth keys its rate limiter on the client IP plus the raw request path, before it matches a
// route. Only the auth paths Voice uses are routed, so a path not listed here, including another
// spelling of a listed one, is a 404 that touches no database.
const authPaths = [
  "/get-session",
  "/sign-out",
  "/sign-in/social",
  "/callback/google",
  "/error",
  "/electron/init-oauth-proxy",
  "/electron/token",
  "/delete-user",
].map((path) => authOptions.basePath + path);

let auth: ReturnType<typeof createAuth> | undefined;
app.on(["GET", "POST"], authPaths, (c) => {
  if (!auth) {
    auth = createAuth(c.env, waitUntil);
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

const scheduled: ExportedHandlerScheduledHandler<Env> = (_controller, env) => sweep(env);

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
