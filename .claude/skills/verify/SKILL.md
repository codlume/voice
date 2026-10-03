---
name: verify
description: Launch and drive the real Voice desktop app (Electron hub, Flow Bar pill, hotkey dictation) in a disposable test-mode instance and capture proof. Use to confirm a user-visible change works in the app, not just in tests, for dictation, Style, Settings, Account, Models, or Home.
---

# Verify Voice

Voice is an Electron app (`apps/desktop`) with a Swift helper (`native/voice-helper`) that owns the hotkey tap, capture, ASR, and insertion. The user touches three surfaces: the global hotkey (hold `fn`, speak, release), the Flow Bar pill window (`pill.html`), and the Voice window, also called the hub (`hub.html`). The menu bar tray has Open Voice, Copy last transcript, Check for updates, and Quit. Agents can't click the tray, so reach the same behavior through the hub.

Every command below goes through one helper, run from the repo root. Spell the path out each time. zsh does not split `$V`-style variables into words.

```sh
node .claude/skills/verify/scripts/voice-verify.mjs <command>
```

It reuses the repo's own harness (`scripts/voice-app.mjs`, the same code `pnpm e2e` uses). Only one verify instance exists at a time. Its state lives in `$TMPDIR/voice-verify.json`.

Before driving a feature, read [features/README.md](features/README.md) and the feature's file. The map lists every entry point. A proof that covers only one of several entry points is incomplete.

## Launch

1. Build what the instance runs. Rebuild after any change, because the instance runs built output, not the dev server:

   ```sh
   swift build --package-path native/voice-helper   # helper, fnpost, disclaim
   node scripts/fixtures.mjs                         # synthetic WAVs in test-fixtures/audio (needs ffmpeg, say)
   pnpm build                                        # apps/desktop/dist-electron + dist/renderer
   ```

2. Start the instance as a background command and keep it running:

   ```sh
   node .claude/skills/verify/scripts/voice-verify.mjs launch     # run_in_background
   ```

   It is ready when it prints a JSON object with `"ready": true`, the CDP port (9355), `userData`, `evidence`, `permissions`, and `models`. A cold run takes 30 to 60 s, mostly CoreML compiling the speech model. The first run ever also downloads about 950 MB of test models into `~/Library/Caches/Voice Development/test-models`.

   What `launch` sets up:
   - Test mode (`VOICE_HELPER_TEST=1`) with a scratch userData at `$TMPDIR/voice-verify`. It never touches `~/Library/Application Support/Voice` or `Voice Development`.
   - The models are symlinks to the shared test-model cache.
   - Capture reads `$TMPDIR/voice-verify/capture.wav`, never the microphone. That file exists only while `dictate` runs. A stray real key press makes the session fail; it does not record or insert.
   - It never opens a browser. When the user clicks `Sign in with Google`, test mode writes the sign-in URL to `$TMPDIR/voice-verify/sign-in-url.txt` instead, and `browser` plays the browser's part.
   - `launch` passes its environment through. Start it with `VOICE_API_URL=http://localhost:8787` to point the instance at a local API Worker. Without it, the Account page reports accounts as unavailable.

3. Teardown: `node .claude/skills/verify/scripts/voice-verify.mjs stop`. See [Cleanup](#cleanup).

To test a restart, `stop --keep-user-data` keeps the scratch userData, and `launch --keep-user-data` starts on it again instead of a fresh one.

## Doctor

```sh
node .claude/skills/verify/scripts/voice-verify.mjs doctor
```

This check is read-only. Run it first, and again whenever something looks off. A healthy instance reports:

- `app`, `helper`, and `fnpost` are `built`, not `stale` or `not built`. A stale build means you'd verify old code, so rebuild and relaunch.
- `instance.cdpPages` lists both `pill.html` and `hub.html`.
- `snapshot.models.asr.state` and `snapshot.models.cleanup.state` are `ready`.
- `snapshot.permissions.accessibility` is `granted`. Accessibility belongs to whatever launched the script (terminal, IDE, or agent host). Without it, the hotkey tap and insertion cannot work, and only a human can grant it in System Settings.
- `otherVoiceProcesses` is empty if you plan to `dictate`. The user's own `Voice.app` and a `pnpm dev` session both show up here.

`snapshot.permissions.microphone` stays `notDetermined` in the scratch instance. That is expected, so don't press Grant.

## Drive

The hub is driven over CDP. Prefer the user path (`click`) over `window.voice.*` calls. Call the API directly only to set up preconditions, never as the proof itself.

| Command                                                  | Does                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`                                                   | Prints `[<nav> nav > <current item>]` and the visible page text. Use it as the cheap accessibility snapshot.                                                                                                                                                                                                                                                                                                               |
| `click <name> [hub\|pill]`                               | Clicks the one visible element whose accessible name (aria-label, aria-labelledby, `<label>`, or text) equals `<name>`, among buttons, links, switches, radios, options, and comboboxes. It waits up to 5 s for that element to exist and be enabled, and fails if several elements match. `css:<selector>` targets by selector instead.                                                                                   |
| `type <css:selector> <text…>`                            | Focuses the one visible hub element matching the selector and inserts the text the way a paste does, so React sees the change. Prints `{ typed: <length> }`. Fails when zero or several elements match.                                                                                                                                                                                                                    |
| `wait <hub\|pill> <expr> [ms]`                           | Polls an expression until it is truthy. A promise is fine: `'window.voice.getSnapshot().then(s => s.session.kind === "idle")'`.                                                                                                                                                                                                                                                                                            |
| `eval <hub\|pill> <expr>`                                | Evaluates an expression and prints the result.                                                                                                                                                                                                                                                                                                                                                                             |
| `snapshot`                                               | Prints the full app snapshot, typed as `Snapshot` in `apps/desktop/src/shared/api.ts`: settings, models, permissions, session, and `last` transcript.                                                                                                                                                                                                                                                                      |
| `shot <name> [hub\|pill]`                                | Saves a PNG to the evidence dir.                                                                                                                                                                                                                                                                                                                                                                                           |
| `note <name> <text…>`                                    | Appends text evidence to `<name>.txt`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `dictate [fixture.wav] [--end=audio\|escape\|immediate]` | Runs one full hotkey session into a scratch Electron textarea and prints `outcome`, `inserted`, `last`, and the `[voice] session … outcome=… startMs=… asrMs=… cleanupMs=… insertMs=…` timing line.                                                                                                                                                                                                                        |
| `browser [google-code]`                                  | Plays the system browser for a pending sign-in against the local verify Worker by running `apps/api/scripts/play-browser.mjs --init-url` on the URL the app wrote to `<userData>/sign-in-url.txt`, with `google-code` (default `ada-lovelace`) as the faked Google account. Prints that script's JSON; `electronCookie` is the code the landing page shows. It deletes the URL file, so each pending sign-in is used once. |
| `callback <code> [--second-instance]`                    | Delivers `com.codlume.voice://auth/callback#token=<code>` to the main process as the `open-url` event macOS would send a packaged build. With `--second-instance`, it launches a second Voice on the same userData with the URL as an argument instead, and prints that copy's exit code.                                                                                                                                  |
| `reopen`                                                 | Closes the Voice window, then opens Voice again: a second copy hands over through the single-instance lock and the running app shows its window, as when the user opens Voice from Finder. Use it to bring the window back.                                                                                                                                                                                                |
| `record <name>`                                          | Screencasts the hub page into `<name>.mp4` in the evidence dir until it gets SIGTERM or SIGINT. Run it in the background, drive the flow, then `kill -TERM` the pid it prints. Without `ffmpeg` it keeps the PNG frames and prints their directory.                                                                                                                                                                        |

Stable handles:

- **Voice nav:** `Home`, `Style`. The sidebar footer button `Settings` opens the Settings nav: `General`, `Account`, `System`, `Models`, `Shortcuts`, `Data and Privacy`. Its `Back` button returns to the Voice nav.
- **Settings rows:** each control's id is `setting-<name>`, for example `#setting-hotkey`, `#setting-microphone`, `#setting-dictation-language`, `#setting-update-channel`, `#setting-mute-while-dictating`, `#setting-show-in-dock`, `#setting-always-show-pill`, `#setting-diagnostics`. Switches are labelled by their row title, such as `Show in Dock`.
- **Selects:** open with `click css:#setting-<name>`, then `click "<option label>"`.
- **Page headline:** `document.querySelector("main h1").textContent`.

`dictate` posts a real synthetic key event. It refuses to run while any other Voice helper or `pnpm dev` is running, because that app's hotkey tap would hear the press and record the room with the real microphone. If it refuses, ask the user to quit Voice.app. Never kill it yourself. It also briefly brings the scratch target window to the front.

## Evidence

Artifacts go to `$TMPDIR/voice-verify-evidence/<runId>/`. `launch` and `stop` print the path. `dictate` writes one JSON file per session there automatically. The repo's `.gitignore` does not cover this directory, which is why evidence lives outside the repo. Never commit evidence.

Proof standards:

- Drive the real user path: a click in the hub, or the hotkey through `dictate`. `window.voice.updateSettings` is a setup shortcut, not proof that a control works.
- Capture the action and the resulting state: a `shot` before and after, plus `text` or `snapshot` output, not only the final screen.
- Check side effects alongside the UI. Settings persist in `$TMPDIR/voice-verify/settings.json`, so `cat` it before `stop` deletes it. Model installs are files in `$TMPDIR/voice-verify/models`. Insertion is the target textarea's value (`inserted`) and `last` in the snapshot. Main-process logs are in `$TMPDIR/voice-verify/main.log`.
- Test mode replaces only the microphone with a fixture WAV. The hotkey tap, ASR, cleanup, and insertion are the production code paths. Don't describe a fixture-driven run as proof of capture-device behavior.
- Use only the synthetic fixtures (`test-fixtures/audio/*.wav`: `short`, `long`, `silence`, `url`, `language-trigger`). Never use real recordings.

## Cleanup

```sh
node .claude/skills/verify/scripts/voice-verify.mjs stop
```

`stop` signals the owner process that `launch` started, which stops the Electron process group it spawned. If the owner is dead, `stop` signals the recorded Electron process group directly. It never kills anything by name. It then deletes the scratch userData and the state file, and prints the evidence dir, which it keeps. Run `stop` after every attempt, including failed ones. After `stop`, `doctor` should report `"instance": "none"`.

## Repo checks that drive the same app

These are scripts the repo already has. Run them when the change is in their area. Each launches its own instance, so `stop` the verify instance first.

- `pnpm e2e` runs six hotkey cases into TextEdit and an Electron textarea: cleanup on and off, silence, Escape, too short.
- `node scripts/models-smoke.mjs` covers model uninstall and reinstall from the Models page.
- `node scripts/quit-smoke.mjs` quits during model loading and during cleanup.
- `node scripts/idle-footprint.mjs` reports idle CPU and memory.
