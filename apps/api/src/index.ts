import { Hono } from "hono";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { routePath } from "hono/route";
import { secureHeaders } from "hono/secure-headers";

const securityHeaders = secureHeaders({
  strictTransportSecurity: "max-age=63072000; includeSubDomains",
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  xFrameOptions: "DENY",
});

const app = new Hono<{ Bindings: Env; Variables: RequestIdVariables }>();

app.use(securityHeaders);
app.use(requestId({ headerName: "" }));

app.get("/health", (c) => c.body(null, 200));

app.onError(async (error, c) => {
  console.error(
    JSON.stringify({
      requestId: c.get("requestId"),
      route: routePath(c),
      status: 500,
      error: error.name,
    }),
  );
  // While securityHeaders is the first middleware, every error response already
  // passes through it. This keeps error responses covered if that order changes.
  await securityHeaders(c, async () => {
    c.res = c.json({ error: "Internal Server Error" }, 500);
  });
  return c.res;
});

export default app;
