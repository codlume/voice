# Voice

Voice is a system-wide dictation app in development. The macOS development app provides setup, shortcut dictation into text fields in native apps, browsers, editors, and terminals, explicit practice dictation, and temporary recovery.

## Develop

Use Apple Silicon macOS, Xcode Command Line Tools, Node `24.21.0`, and pnpm `11.10.0`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` builds the Swift helper and Electron entry points, waits for Vite, and opens the settings window. Renderer and shared-token edits support HMR. Restart the command after main, worker, or Swift edits. Quit the app or press Ctrl+C to stop its processes and server.

Development and unsigned packages use `~/Library/Application Support/Voice Development`. Automated desktop tests use a fresh temporary directory. Neither uses production settings. Startup does not request the microphone or contact a transcription provider.

## Check and package

```sh
pnpm fmt
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:toolchain
pnpm build:renderer
pnpm exec playwright install chromium
pnpm test:renderer
pnpm test:hmr
pnpm test:native
pnpm build:desktop
pnpm package:desktop
pnpm test:desktop-smoke
```

The unsigned app is at `out/Voice Development-darwin-arm64/Voice Development.app`. It runs without Vite. Change Appearance, save, quit, and reopen to verify persistence. Storage failures offer **Try again** without claiming a successful save.

Renderer tests use a simulated preload. Desktop smoke tests launch the actual packaged Electron runtime, storage worker, SQLite migrations, and Swift helper. They use synthetic preferences and injected failures, never microphone capture or live providers. They drive shortcut sessions through a test hook rather than a native key tap, so they do not establish native dictation or target-app compatibility.

The real-Mac dictation proof is opt-in because it needs Accessibility and Input Monitoring for the launching terminal and a scratch TextEdit document:

```sh
VOICE_NATIVE_PROOF=1 pnpm exec playwright test --config tests/desktop/playwright.config.ts tests/desktop/dictation.spec.ts
```

It posts real Fn and Escape events through the helper's event tap, inserts through Accessibility into TextEdit at the caret and over a selection, checks the focus-change and Escape paths, and pastes after a real click. A second proof clicks the floating bar and the menu-bar menu for real while TextEdit is focused, opens recovery during a session, and cancels from the bar while a secure-input dialog hides Escape. Audio is synthetic and the provider is a loopback fixture, so these prove control, target, and insertion behavior, not recognition quality. They write `test-results/native-proof.json` and `test-results/entry-proof.json` with the app, OS, TextEdit version, and the document text after every step. A third proof pastes through the clipboard into a scratch window whose field has no direct insertion. It uses synthetic plain, rich, and non-text clipboards, a concurrent copy, clipboards that cannot be kept, a focus change, a paste the field ignores, and a helper terminated mid-paste. Run it while you are not using the Mac, because it brings its scratch window to the front many times. It keeps your clipboard in the scratch process's memory and refuses to start if it cannot keep it exactly. It stops if another app takes focus or you copy something during the run, and it never replaces a copy you made meanwhile. It writes `test-results/clipboard-proof.json` with only synthetic field text and per-step booleans about the clipboard.

The pre-commit hook formats staged files only. CI runs `Check`, `Test`, and `macOS Desktop`; no signing or publishing jobs are configured.

## Dictate into another app

Click into a text field, hold **Fn**, speak, and release. Voice inserts the transcript at the caret or over the current selection of the field that was focused when you pressed the shortcut. **Fn+Space** toggles hands-free dictation and **Escape** cancels; all three bindings are configurable in setup.

After setup, a small floating bar stays near the bottom of the screen with **Start**. It widens while a session runs to show its status with **Stop** and **Cancel**, then briefly shows the outcome with a repair action such as **Open recovery** or **Open Settings**. The Voice menu-bar icon offers the same Start, Stop, and Cancel, plus **Copy last transcript**, **Paste last transcript**, and **Open recovery**. Clicking the bar or the menu keeps your text field focused, so a session started there inserts like a shortcut session. Clickable Cancel still works where a protected field blocks Escape. Starting from the Voice window keeps the transcript in recovery, because Voice is in front. Unavailable actions are disabled with the reason, such as full recovery or incomplete setup, and are never queued.

Insertion happens only when that original field is still focused. If focus moved away at any point, the field closed, or the field is protected or unsupported, the transcript waits in Temporary recovery instead. If the field accepted the text but Voice could not confirm the placement, the status says **Check your target** and the text is retained without a second attempt. In a terminal, Voice types the transcript as a single line: line breaks, tabs, and control characters become spaces and Return is never pressed, so nothing runs until you press it. A terminal cannot confirm what it received, so terminal insertion always says **Check your target**. A password prompt with secure keyboard entry goes to recovery. Voice reads no document text or selection contents to decide where text goes.

Some fields accept typing but not direct insertion. For those, Voice pastes through the clipboard and says **Inserted with a clipboard paste**. Before pasting, the native helper keeps an exact copy of everything on your clipboard, in every format, for that one paste only. Afterwards it puts the copy back. If you copied something new in the meantime, your new copy stays. Voice marks its temporary value so clipboard managers can skip it. If the clipboard holds something Voice cannot keep exactly, such as concealed password-manager content, data another app fails to provide, or promised files, Voice leaves the clipboard untouched and keeps the transcript in recovery for **Copy**. If the helper stops mid-paste, the status says your clipboard may still hold the transcript.

## Recover a session

Temporary recovery keeps up to five undelivered sessions and the latest successful transcript for this app run. Copy writes the selected text to the clipboard. Paste arms a single insertion: click into the field that should receive the text and Voice inserts it there once, or press Escape or **Cancel paste** to keep it. Paste waits at most 20 seconds and never uses a field you did not select after clicking Paste. For incomplete transcription, Copy and Paste keep the unresolved recording; Discard removes both. At five unresolved sessions, resolve or discard one before starting another.

**Retry** transcribes a retained recording again with the microphone off. The result stays in recovery for you to Copy or Paste, so text you already delivered is never replaced or pasted twice. A failed or cancelled Retry keeps the recording.

Closing the window keeps Voice and recovery alive. Reopen it from the Dock. Quit Voice warns before losing undelivered work and offers Return to recovery. Audio and transcripts are not saved as history. Recovery survives a window reload and a restart of Voice's native helper or transcription worker, but not quitting Voice or a crash of the app itself.

## When recording stops on its own

Voice stops recording at once when it can no longer use what it records or sends: you add, replace, or remove your Deepgram key; Deepgram rejects the key or reports exhausted quota; the microphone disconnects or its access is revoked; or Voice's native helper stops. The recording and any text so far stay in Temporary recovery, marked incomplete. A key change is not a Cancel: the recording is kept. After you fix the cause, nothing resends or records by itself. Use **Retry**, which needs a saved key, or start a new session. After adding credit to an exhausted Deepgram account, click **Refresh setup status** before starting again.

Voice restarts its native helper automatically. Shortcuts work again once setup shows it ready. A shortcut key held from before the restart starts nothing; release it and press again. A dropped connection, a rate limit, or a stopped transcription worker does not stop the recording. Voice replaces the worker and transcribes the full recording once after you stop, within the same time limit.

## Dictate without a connection

Transcription needs internet, but a lost connection never stops a recording you started. Start works offline, and the status shows a connection warning until you stop. After Stop, Voice sends the whole recording once more on a new connection, as soon as the connection returns. That one automatic attempt, and any Retry, must finish within 10 seconds for recordings up to 30 seconds, or 30 seconds for longer ones. Replay runs at no more than 1.25× real time, so a 30-second recording needs at least 24 seconds and a five-minute recording at least 240 seconds. A replay that cannot fit its limit times out, and the recording stays in recovery with its audio and any available text, marked incomplete. A connection that returns later never resends, inserts, or starts recording on its own.

## Pinned storage compatibility

`patches/drizzle-orm@1.0.0-rc.4.patch` keeps the accepted Drizzle/Effect/TypeScript pins usable together. It changes the renamed Effect `TaggedErrorClass` API to `TaggedError`, restores column/role declarations omitted from Drizzle's published types but present in its source maps, removes invalid covariance annotations, and removes a stripped internal field from SQLite's excluded-method union. Both module formats are patched. Strict library checking stays enabled.

The storage tests exercise the patched import, migration, query, update, failure, and close/reopen paths. Reassess and remove this patch when upgrading the dependency pins. Generate future settings migrations with `pnpm exec drizzle-kit generate --config packages/storage/drizzle.config.ts`; Drizzle owns the only migration history.
