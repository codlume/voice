import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { parseSingleRule, securityHeaders } from "./headers.ts";
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

  it("come from a file with exactly one rule, for every path (catches a second rule whose headers the server-rendered page would also get, or a rule for a narrower path)", () => {
    expect(() => parseSingleRule("/*\n  A: 1\n/privacy\n  B: 2\n")).toThrow("exactly one rule");
    expect(() => parseSingleRule("/privacy\n  A: 1\n")).toThrow("exactly one rule");
    expect(parseSingleRule("/*\n  A: 1\n  B: x; y\n")).toEqual({ A: "1", B: "x; y" });
  });
});

const render = () =>
  onRequest(
    {} as Parameters<typeof onRequest>[0],
    async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }),
  ) as Promise<Response>;

describe("middleware", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
