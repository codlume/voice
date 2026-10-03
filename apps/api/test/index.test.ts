import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import app from "../src/index.ts";

// Registered before any request so the router includes them.
app.get("/boom/:id", () => {
  throw new Error("secret detail that must not leak");
});
// @ts-expect-error A handler that returns nothing reaches onError without unwinding through the middleware.
app.get("/no-response", () => undefined);

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get("Strict-Transport-Security")).toBe(
    "max-age=63072000; includeSubDomains",
  );
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("security headers", () => {
  it("are on /health served by the real Worker entry (catches a dropped or weakened secureHeaders)", async () => {
    const response = await exports.default.fetch("https://api.test/health");

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
  });

  it("are on a 404 (catches not-found responses that bypass the middleware)", async () => {
    const response = await exports.default.fetch("https://api.test/does-not-exist");

    expect(response.status).toBe(404);
    expectSecurityHeaders(response);
  });
});

describe("/health", () => {
  it("answers without touching the database (catches a health check that fails when D1 is down)", async () => {
    const throwingDb = new Proxy(
      {},
      {
        get() {
          throw new Error("health touched env.DB");
        },
      },
    );

    const response = await app.fetch(
      new Request("https://api.test/health"),
      { ...env, DB: throwingDb as D1Database },
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
  });
});

describe("errors", () => {
  it("return a generic 500 with security headers and log one line without the URL, message or client request id (catches leaking details)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.fetch(
      new Request("https://api.test/boom/user-7731?token=query-secret", {
        headers: { "X-Request-Id": "client-supplied-id" },
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expectSecurityHeaders(response);
    const body = await response.text();
    expect(body).not.toContain("secret detail");
    expect(JSON.parse(body)).toEqual({ error: "Internal Server Error" });

    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0]?.[0]);
    const entry = JSON.parse(line);
    expect(Object.keys(entry).toSorted()).toEqual(["error", "requestId", "route", "status"]);
    expect(entry).toMatchObject({ route: "/boom/:id", status: 500, error: "Error" });
    expect(entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.requestId).not.toBe("client-supplied-id");
    expect(line).not.toContain("user-7731");
    expect(line).not.toContain("query-secret");
    expect(line).not.toContain("secret detail");
  });

  it("keep the security headers when a handler returns no response (catches onError responses that skip secureHeaders)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await app.fetch(
      new Request("https://api.test/no-response"),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expectSecurityHeaders(response);
  });
});
