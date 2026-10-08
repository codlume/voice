import { createHash } from "node:crypto";

// Better Auth redirects here after /callback/google, because init-oauth-proxy
// drops callbackURL. The page hands the electron code to Voice and ends the
// browser's own auth session, which the callback created and Voice never uses.

// The colors and fonts are the desktop app's tokens (apps/desktop/src/renderer/tokens.stylex.ts).
const style = `
:root {
  color-scheme: light dark;
  --background: oklch(99.2% 0 0);
  --foreground: oklch(27.4% 0.006 286.033);
  --muted: oklch(55.2% 0.016 285.938);
  --card: white;
  --border: oklch(92% 0.004 286.32);
  --primary: oklch(0.488 0.217 264);
  --success: oklch(50.8% 0.118 165.612);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(14.5% 0 0);
    --foreground: oklch(97% 0 0);
    --muted: color-mix(in srgb, oklch(55.6% 0 0) 90%, white);
    --card: color-mix(in srgb, oklch(14.5% 0 0) 97%, white);
    --border: rgb(255 255 255 / 6%);
    --primary: oklch(0.571 0.21 264);
    --success: oklch(76.5% 0.177 163.223);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none; }
body { display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 2rem 1.5rem; background: var(--background); color: var(--foreground); }
main { display: flex; flex-direction: column; align-items: center; gap: 1.25rem; max-width: 26rem; text-align: center; text-wrap: balance; }
.mark { display: grid; place-items: center; width: 56px; height: 56px; border-radius: 999px; background: color-mix(in srgb, var(--success) 14%, transparent); color: var(--success); }
.mark.quiet { background: color-mix(in srgb, var(--muted) 14%, transparent); color: var(--muted); }
svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
h1 { margin: 0.25rem 0 0; font: 400 32px/1.15 ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif; letter-spacing: -0.01em; }
p { margin: 0; color: var(--muted); }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.open { margin-top: 0.5rem; padding: 10px 24px; border-radius: 999px; background: var(--primary); color: white; font-weight: 500; text-decoration: none; }
.open:hover { background: color-mix(in srgb, var(--primary) 90%, transparent); }
details { margin-top: 1.5rem; font-size: 13px; }
summary { color: var(--muted); cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary:hover { color: var(--foreground); }
details[open] summary { margin-bottom: 0.75rem; }
details p { font-size: 12.5px; }
.code { display: flex; gap: 8px; align-items: center; margin-top: 0.5rem; }
code { flex: 1; min-width: 0; padding: 6px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: left; word-break: break-all; user-select: all; }
button { flex-shrink: 0; padding: 6px 14px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--foreground); font: inherit; cursor: pointer; }
`;

const script = `
const name = "better-auth.electron=";
const code = document.cookie.split("; ").find((cookie) => cookie.startsWith(name))?.slice(name.length);
if (code) {
  const url = "com.codlume.voice://auth/callback#token=" + code;
  const codeBox = document.getElementById("code");
  const copy = document.getElementById("copy");
  document.getElementById("open").href = url;
  codeBox.textContent = code;
  copy.addEventListener("click", () => {
    navigator.clipboard.writeText(code).then(
      () => { copy.textContent = "Copied"; },
      () => getSelection().selectAllChildren(codeBox),
    );
  });
  document.getElementById("signed-in").hidden = false;
  fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", keepalive: true });
  location.replace(url);
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
<div class="mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></div>
<h1>You’re signed in to Voice</h1>
<p>Return to Voice to continue. You can close this tab.</p>
<a id="open" class="open">Open Voice</a>
<details>
<summary>Voice didn’t open?</summary>
<p>Copy this code and paste it in Voice under Settings &gt; Account.</p>
<div class="code"><code id="code"></code><button id="copy" type="button">Copy</button></div>
</details>
</main>
<main id="expired" hidden>
<div class="mark quiet"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
<h1>This sign-in link has expired</h1>
<p>Go back to Voice and sign in again. You can close this tab.</p>
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
