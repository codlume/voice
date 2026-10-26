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

  it("warns next to the code that it signs in to the account, and carries the state the sign-in gate redirects to (catches a page that frames the code as something to share)", async () => {
    const html = await (await exports.default.fetch("http://localhost:8787/")).text();

    expect(html).toContain('<main id="start-in-voice" hidden>');
    expect(html).toContain("Open Voice and click Sign in with Google.");
    expect(html).toContain(
      "Voice runs on your Mac or Windows PC. Open Voice there and click Sign in with Google.",
    );
    const disclosure = html.match(/<details>([\s\S]*?)<\/details>/)?.[1] ?? "";
    expect(disclosure).toContain('<code id="code">');
    expect(disclosure).toContain(
      "Paste this code only into Voice, under Settings &gt; Account. Anyone who has it can sign in to your Voice account. Voice will never ask you to send it to anyone. If you did not just click Sign in with Google in Voice, close this page.",
    );
  });

  it("is where Better Auth's error route sends a failed sign-in, with the code in the query (catches the route serving its own HTML page)", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost:8787/api/auth/error?error=access_denied", {
        headers: { "cf-connecting-ip": "192.0.2.2" },
        redirect: "manual",
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("http://localhost:8787/?error=access_denied");
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
