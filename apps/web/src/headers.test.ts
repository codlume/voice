import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { securityHeaders } from "./headers.ts";
import { onRequest } from "./middleware.ts";

const expected = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

describe("security headers", () => {
  it("are the rule Workers Assets applies to the prerendered pages (catches a weakened or dropped line in public/_headers)", () => {
    expect(securityHeaders).toEqual(expected);
  });
});

describe("middleware", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const render = () =>
    onRequest(
      {} as Parameters<typeof onRequest>[0],
      async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }),
    ) as Promise<Response>;

  it("puts the same headers on the server-rendered page in production (catches an SSR route that goes out bare)", async () => {
    vi.stubEnv("PROD", true);

    const response = await render();

    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/html",
      ...Object.fromEntries(Object.entries(expected).map(([k, v]) => [k.toLowerCase(), v])),
    });
  });

  it("leaves the dev server alone, whose own scripts the CSP would block", async () => {
    vi.stubEnv("PROD", false);

    const response = await render();

    expect(response.headers.get("Content-Security-Policy")).toBeNull();
  });
});
