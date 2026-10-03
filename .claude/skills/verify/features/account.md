# Account

Settings > Account signs the user in with Google. `Sign in with Google` opens the system browser on the Voice API, and the user picks a Google account. Voice then shows the user's initials, name, and email. A build that cannot receive the `com.codlume.voice://` callback, such as a development build, signs in by pasting the code that the browser's landing page shows. The page shows one of five states: unavailable, signed out, signing in, signed in, or an error with Retry and Dismiss.

## Sub-features

- `account-sign-in`: `Sign in with Google` moves the page to "Waiting for your browser…".
- `account-paste-code`: paste the landing page's code into `Sign-in code` and press `Continue` or Enter. A malformed code shows "Paste the whole code shown in the browser." and the page keeps waiting.
- `account-cancel`: `Cancel sign-in` returns to signed out. A code that arrives after the cancel does not count.
- `account-error`: a rejected code shows the error with `Retry` (signs in again) and `Dismiss` (back to signed out).
- `account-unavailable`: a build with no API URL says accounts are unavailable and offers no button.

## How to get to it (user POV)

- Voice window > `Settings` (sidebar footer, or Cmd-,) > `Account`, the second item.
- Handles: `Sign in with Google` (`#setting-sign-in`), `Sign-in code` (`#setting-sign-in-code`), `Continue`, `Cancel sign-in`, `Retry`, `Dismiss`. The headline is `Account`.

## Driving it with voice-verify

Preconditions: baseline, plus the API verify Worker on `http://localhost:8787`. Migrate it once with `pnpm --filter @voice/api db:migrate:verify`, then run `pnpm --filter @voice/api dev:verify` in the background. It fakes Google and is never deployed. Launch the instance with `VOICE_API_URL=http://localhost:8787 node .claude/skills/verify/scripts/voice-verify.mjs launch`.

To film a flow, start `vv record account-sign-in` in the background first, and `kill -TERM` the pid it prints when the flow ends.

- **Signed out.** `vv click Settings`, `vv click Account`, `vv wait hub 'document.querySelector("main h1")?.textContent === "Account"'`, `vv shot account-signed-out`. `vv snapshot` shows `account.kind` is `signedOut`.
- **Sign in.** `vv click "Sign in with Google"`, `vv wait hub 'window.voice.getSnapshot().then(s => s.account.kind === "signingIn")'`, `vv shot account-signing-in`.
- **Paste the code.** `vv browser ada-lovelace` prints `code`. It also prints `sessionAfterSignOut: null`, which proves that the browser's own auth session ended. Then `vv type css:#setting-sign-in-code <code>`, `vv click Continue`, `vv wait hub 'window.voice.getSnapshot().then(s => s.account.kind === "signedIn")'`, `vv shot account-signed-in`. `vv text` shows "Ada Lovelace" and "ada-lovelace@example.com". `vv snapshot` shows `account: { kind: "signedIn", name, email }`, and `vv snapshot | grep -c token` prints 0.
- **Malformed paste.** While signing in, `vv type css:#setting-sign-in-code not-a-code`, then `vv click Continue`. `vv wait hub 'document.querySelector("[role=alert]")?.textContent === "Paste the whole code shown in the browser."'` passes, and the state stays `signingIn`.
- **Cancel.** Sign in, then `vv click "Cancel sign-in"` and wait for `signedOut`. `vv browser` still prints a code. The page has no paste box while signed out, so check the gate through the API: `vv eval hub 'window.voice.submitSignInCode("<code>").catch(e => e.message)'`, then `vv snapshot` still shows `signedOut`.
- **Error.** While signing in, paste a well-formed code that no sign-in issued: `vv type css:#setting-sign-in-code eyJpZGVudGlmaWVyIjoidW5rbm93biIsInN0YXRlIjoidW5rbm93biJ9` (base64url of `{"identifier":"unknown","state":"unknown"}`), then `vv click Continue`. Wait for `s.account.kind === "error"` and `vv shot account-error`. `vv click Retry` returns to `signingIn`. Reach the error again, then `vv click Dismiss` returns to `signedOut`.
- **Unavailable.** `stop`, then launch without `VOICE_API_URL`. The Account page reads "Accounts are unavailable" with a reason that names `VOICE_API_URL`, and has no button.

## Gotchas

- These recipes were written before their first live run. Record what differs when you run them.
- The verify Worker must listen on port 8787 and be migrated. Otherwise `browser` fails on its first request.
- `browser` consumes the pending sign-in URL and deletes `sign-in-url.txt`. Click `Sign in with Google` again before the next `browser`.
- A rejected code consumes the PKCE verifier, so after an error, `Retry` starts a new sign-in. An old code never works again.
- The verify Worker fakes Google. The real Google round trip is a manual check: run `pnpm --filter @voice/api dev` with the dev OAuth client and sign in from a browser.
