import { createHash } from "node:crypto";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

const inline = (html: string, tag: string) => {
  const match = html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  expect(match, `one inline <${tag}>`).not.toBeNull();
  return `'sha256-${createHash("sha256")
    .update(match?.[1] ?? "")
    .digest("base64")}'`;
};

describe("landing page", () => {
  it("allows only its own inline script and style by hash (catches a CSP that blocks the page or allows other code)", async () => {
    const response = await exports.default.fetch("http://localhost:8787/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      `default-src 'none'; script-src ${inline(html, "script")}; style-src ${inline(html, "style")}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    );
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(html).toContain("better-auth.electron");
    expect(html).toContain("/api/auth/sign-out");
    expect(html).toContain("com.codlume.voice://auth/callback#token=");
  });

  it("does not loosen the CSP of JSON routes (catches the landing policy leaking to other routes)", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost:8787/api/auth/get-session", {
        headers: { "cf-connecting-ip": "192.0.2.1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
