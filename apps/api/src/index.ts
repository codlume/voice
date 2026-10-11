import { waitUntil } from "cloudflare:workers";
import { Hono, type Handler, type MiddlewareHandler } from "hono";
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

type AppEnv = { Bindings: Env; Variables: RequestIdVariables };

export const app = new Hono<AppEnv>({
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
// route. Only the auth paths Voice uses are routed (the sign-in start, GET only and gated below,
// and these), so any other path, including another spelling of a routed one, is a 404 that
// touches no database.
const initPath = `${authOptions.basePath}/electron/init-oauth-proxy`;
const authPaths = [
  "/get-session",
  "/sign-out",
  "/callback/google",
  "/error",
  "/electron/token",
  "/delete-user",
].map((path) => authOptions.basePath + path);

let auth: ReturnType<typeof createAuth> | undefined;
const handleAuth: Handler<AppEnv> = (c) => {
  if (!auth) {
    auth = createAuth(c.env, waitUntil);
    // A lazy instance ties its setup to the first request; keep it alive if that request is aborted (better-auth#10315).
    waitUntil(auth.$context);
  }
  return auth.handler(c.req.raw);
};

const fetchSites = new Set(["same-origin", "same-site", "cross-site"]);

// Whoever builds a start link holds the PKCE verifier for the code it ends in. Browsers mark a
// start that Voice opens from outside the browser `none`; a link on a web page arrives
// `cross-site`. Browsers without Fetch Metadata and header-less clients send nothing and pass.
const refuseStartsFromWebPages: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secFetchSite = c.req.header("sec-fetch-site") ?? "none";
  if (secFetchSite === "none") return next();
  console.log(
    JSON.stringify({
      requestId: c.get("requestId"),
      route: initPath,
      status: 302,
      refused: "sec-fetch-site",
      secFetchSite: fetchSites.has(secFetchSite) ? secFetchSite : "other",
    }),
  );
  return c.redirect("/#start-in-voice");
};

// The start is a GET in Better Auth, so a POST to it is unrouted and takes no step in the limiter.
app.get(initPath, refuseStartsFromWebPages, handleAuth);
app.on(["GET", "POST"], authPaths, handleAuth);

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
