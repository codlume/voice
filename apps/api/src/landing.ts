import { createHash } from "node:crypto";

// Better Auth redirects here after /callback/google, because init-oauth-proxy
// drops callbackURL. The page hands the electron code to Voice and ends the
// browser's own auth session, which the callback created and Voice never uses.

const style = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { max-width: 32rem; margin: 15vh auto; padding: 0 1.5rem; }
code { display: block; padding: 0.75rem; border: 1px solid; border-radius: 0.5rem; word-break: break-all; user-select: all; }
`;

const script = `
const name = "better-auth.electron=";
const code = document.cookie.split("; ").find((cookie) => cookie.startsWith(name))?.slice(name.length);
if (code) {
  document.getElementById("code").textContent = code;
  document.getElementById("signed-in").hidden = false;
  fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", keepalive: true });
  location.replace("com.codlume.voice://auth/callback#token=" + code);
} else {
  document.getElementById("expired").hidden = false;
}
`;

export const landingPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice sign-in</title>
<style>${style}</style>
</head>
<body>
<main id="signed-in" hidden>
<h1>Signed in</h1>
<p>Voice should open by itself. If it does not, paste this code into Voice &gt; Settings &gt; Account.</p>
<code id="code"></code>
</main>
<main id="expired" hidden>
<h1>Link expired</h1>
<p>This sign-in link has expired. Go back to Voice and sign in again.</p>
</main>
<script>${script}</script>
</body>
</html>
`;

const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

export const landingCsp = {
  defaultSrc: ["'none'"],
  scriptSrc: [hash(script)],
  styleSrc: [hash(style)],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
};
