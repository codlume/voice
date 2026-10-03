# Account

Settings > Account signs the user in with Google. `Sign in with Google` opens the system browser on the Voice API, and the user picks a Google account. Voice then shows the user's initials, name, and email. A build that cannot receive the `com.codlume.voice://` callback, such as a development build, signs in by pasting the code that the browser's landing page shows. The page shows one of five states: unavailable, signed out, signing in, signed in, or an error with Retry and Dismiss.

## Sub-features

- `account-sign-in`: `Sign in with Google` moves the page to "Waiting for your browser…".
- `account-paste-code`: paste the landing page's code into `Sign-in code` and press `Continue` or Enter. A malformed code shows "Paste the whole code shown in the browser." and the page keeps waiting.
- `account-callback`: the landing page's `com.codlume.voice://auth/callback#token=<code>` URL signs Voice in without a paste. A packaged build gets it from macOS; the verify instance gets the same `open-url` event through `vv callback`.
- `account-cancel`: `Cancel sign-in` returns to signed out. A code that arrives after the cancel does not count.
- `account-error`: a rejected code shows the error with `Retry` (signs in again) and `Dismiss` (back to signed out).
- `account-unavailable`: a build with no API URL says accounts are unavailable and offers no button.
- `account-restore`: after a restart Voice is still signed in, also with the API down. The auth session is stored encrypted in `config.json` under `voice.<installedChannel>` (a development build uses `voice.stable`).
- `account-ended`: when the API no longer knows the auth session, the page says "Your sign-in expired or was revoked." with Retry and Dismiss. Voice asks the API at launch and when the window gets focus (shown, unminimized, Cmd-Tab), at most once an hour.

## How to get to it (user POV)

- Voice window > `Settings` (sidebar footer, or Cmd-,) > `Account`, the second item.
- Handles: `Sign in with Google` (`#setting-sign-in`), `Sign-in code` (`#setting-sign-in-code`), `Continue`, `Cancel sign-in`, `Retry`, `Dismiss`. The headline is `Account`.

## Driving it with voice-verify

Preconditions: baseline, plus the API verify Worker on `http://localhost:8787`. Migrate it once with `pnpm --filter @voice/api db:migrate:verify`, then run `pnpm --filter @voice/api dev:verify` in the background. It fakes Google and is never deployed. Launch the instance with `VOICE_API_URL=http://localhost:8787 node .claude/skills/verify/scripts/voice-verify.mjs launch`.

To film a flow, start `vv record account-sign-in` in the background first, and `kill -TERM` the pid it prints when the flow ends.

- **Signed out.** `vv click Settings`, `vv click Account`, `vv wait hub 'document.querySelector("main h1")?.textContent === "Account"'`, `vv shot account-signed-out`. `vv snapshot` shows `account.kind` is `signedOut`.
- **Sign in.** `vv click "Sign in with Google"`, `vv wait hub 'window.voice.getSnapshot().then(s => s.account.kind === "signingIn")'`, `vv shot account-signing-in`.
- **Paste the code.** `vv browser ada-lovelace` runs `apps/api/scripts/play-browser.mjs` on the URL the app wrote and prints its JSON: `steps.init` 302 to Google, `steps.callback` 302, `steps.landing` 200 with the CSP, `steps.signOut` 200, `steps.browserSessionAfterSignOut` null (the browser's own auth session ended), and `electronCookie`, which is the code the landing page shows. Then `vv type css:#setting-sign-in-code <electronCookie>`, `vv click Continue`, `vv wait hub 'window.voice.getSnapshot().then(s => s.account.kind === "signedIn")'`, `vv shot account-signed-in`. `vv text` shows "Ada Lovelace" and "ada-lovelace@example.com". `vv snapshot` shows `account: { kind: "signedIn", name, email }`, and `vv snapshot | grep -c token` prints 0.
- **Callback URL.** `stop`, then a fresh `launch` (the page has no sign-out yet), `vv click "Sign in with Google"`, `vv browser grace-hopper`, then `vv callback <electronCookie>`. The main process receives the same `open-url` event macOS sends a packaged build, and `vv wait hub 'window.voice.getSnapshot().then(s => s.account.kind === "signedIn")'` passes with "Grace Hopper".
- **Malformed paste.** While signing in, `vv type css:#setting-sign-in-code not-a-code`, then `vv click Continue`. `vv wait hub 'document.querySelector("[role=alert]")?.textContent === "Paste the whole code shown in the browser."'` passes, and the state stays `signingIn`.
- **Cancel.** Sign in, then `vv click "Cancel sign-in"` and wait for `signedOut`. `vv browser` still prints a code. The page has no paste box while signed out, so deliver it as a callback: `vv callback <electronCookie>`, then `vv snapshot` still shows `signedOut` and `main.log` has "account: callback ignored while signedOut".
- **Error.** While signing in, paste a code that carries this attempt's state but an identifier the API never issued. The state is the `state` query parameter of `$TMPDIR/voice-verify/sign-in-url.txt`; the code is base64url of `{"identifier":"unknown","state":"<that state>"}`. `vv type css:#setting-sign-in-code <code>`, then `vv click Continue`. Wait for `s.account.kind === "error"` and `vv shot account-error`. `vv click Retry` returns to `signingIn`. Reach the error again, then `vv click Dismiss` returns to `signedOut`.
- **Stale code.** Sign in, `vv browser old-attempt`, `vv click "Cancel sign-in"`, sign in again, then paste the old `electronCookie` and `vv click Continue`. The alert starts with "That code is from an earlier sign-in" and the state stays `signingIn`; `vv callback <old code>` is ignored too (`main.log` says "code from another sign-in ignored"). `vv browser second-attempt` and pasting its code then signs in.
- **Restart.** Signed in, `stop --keep-user-data`, then `launch --keep-user-data` with the same environment. `vv wait hub 'window.voice.getSnapshot().then(s => s.account.kind === "signedIn")'` passes without a sign-in, and the Worker log shows one `GET /api/auth/get-session` for the launch.
- **Offline.** Stop the verify Worker, then relaunch as above. The account stays `signedIn` and `main.log` has "account auth session check failed". A captive portal behaves the same: serve `200 text/html` on the Worker's port instead, and `config.json`'s `identity` stays byte-for-byte the same.
- **Expired or revoked.** Launch with `VOICE_AUTH_SESSION_CHECK_MS=60000` as well (test mode only; the hourly check becomes one minute). With the Worker running, end the auth session on the server: `pnpm --filter @voice/api exec wrangler d1 execute DB --local --config wrangler.verify.jsonc --persist-to .wrangler/verify --command "delete from session"`. The check runs when the window gets focus. `vv reopen` gives it focus only while Voice is the active app (`vv eval hub 'document.hasFocus()'`); when another app is in front, focus the window from the main process with `app.focus({ steal: true })` and `hub.focus()` over the inspector port. Focus within the minute leaves it `signedIn` with no new `get-session`. After the minute it lands in `error` with the message, `vv click Dismiss` reaches `signedOut`, and `config.json` holds `null` for the channel's cookie, so the next launch builds no client.
- **Nothing in plain text.** While signed in, `grep -rlaF` the scratch userData for the email, the name, `session_token` and the token from `select token from session` in local D1. Each finds nothing. `config.json` holds base64 values that decode to safeStorage ciphertext (`v10…`).
- **Unavailable.** `stop`, then launch without `VOICE_API_URL`. The Account page reads "Accounts are unavailable" with a reason that names `VOICE_API_URL`, and has no button.

## Gotchas

- Every recipe above ran against the real app on 2026-10-03 (paste path, callback path, cancel, malformed paste, error, restart, offline, expired or revoked, nothing in plain text). `vv` is a shell function or a spelled-out command; zsh does not split a `$VV` variable into words.
- The verify Worker must be migrated and must listen on the port in `VOICE_API_URL`. When 8787 is taken, run `pnpm --filter @voice/api dev:verify --port 8797 --var BETTER_AUTH_URL:http://localhost:8797` and launch with `VOICE_API_URL=http://localhost:8797`.
- `stop` and a plain `launch` wipe the scratch userData, auth session included. Only the `--keep-user-data` pair carries it over.
- `vv record` ends when `vv reopen` closes the window; start a new recording after the reopen.
- `browser` consumes the pending sign-in URL and deletes `sign-in-url.txt`. Click `Sign in with Google` again before the next `browser`.
- A rejected code consumes the PKCE verifier, so after an error, `Retry` starts a new sign-in. An old code never works again, and a code whose state is not the current attempt's is refused before it reaches the API.
- The verify Worker fakes Google. The real Google round trip is a manual check: run `pnpm --filter @voice/api dev` with the dev OAuth client and sign in from a browser.
