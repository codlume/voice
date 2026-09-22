# Voice

Voice is a system-wide dictation app in development. The macOS development app provides setup, shortcut dictation into native text fields such as TextEdit, explicit practice dictation, and temporary recovery. Browser, editor, and terminal targets are still in development.

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

It posts real Fn and Escape events through the helper's event tap, inserts through Accessibility into TextEdit at the caret and over a selection, checks the focus-change and Escape paths, and pastes after a real click. Audio is synthetic and the provider is a loopback fixture, so it proves shortcut, target, and insertion behavior, not recognition quality. It writes `test-results/native-proof.json` with the app, OS, TextEdit version, and the document text after every step.

The pre-commit hook formats staged files only. CI runs `Check`, `Test`, and `macOS Desktop`; no signing or publishing jobs are configured.

## Dictate into another app

Click into a text field, hold **Fn**, speak, and release. Voice inserts the transcript at the caret or over the current selection of the field that was focused when you pressed the shortcut. **Fn+Space** toggles hands-free dictation and **Escape** cancels; all three bindings are configurable in setup. A small status panel appears near the bottom of the screen while a session runs and never takes focus.

Insertion happens only when that original field is still focused. If focus moved away at any point, the field closed, or the field is protected or unsupported, the transcript waits in Temporary recovery instead. If the field accepted the text but Voice could not confirm the placement, the status says **Check your target** and the text is retained without a second attempt. Terminals are not supported yet and always go to recovery. Voice reads no document text, selection contents, or clipboard data to decide where text goes.

## Recover a session

Temporary recovery keeps up to five undelivered sessions and the latest successful transcript for this app run. Copy writes the selected text to the clipboard. Paste arms a single insertion: click into the field that should receive the text and Voice inserts it there once, or press Escape or **Cancel paste** to keep it. Paste waits at most 20 seconds and never uses a field you did not select after clicking Paste. For incomplete transcription, Copy and Paste keep the unresolved recording; Discard removes both. At five unresolved sessions, resolve or discard one before starting another. Transcription Retry is not available yet.

Closing the window keeps Voice and recovery alive. Reopen it from the Dock. Quit Voice warns before losing undelivered work and offers Return to recovery. Audio and transcripts are not saved as history and cannot be recovered after app exit or a crash.

## Pinned storage compatibility

`patches/drizzle-orm@1.0.0-rc.4.patch` keeps the accepted Drizzle/Effect/TypeScript pins usable together. It changes the renamed Effect `TaggedErrorClass` API to `TaggedError`, restores column/role declarations omitted from Drizzle's published types but present in its source maps, removes invalid covariance annotations, and removes a stripped internal field from SQLite's excluded-method union. Both module formats are patched. Strict library checking stays enabled.

The storage tests exercise the patched import, migration, query, update, failure, and close/reopen paths. Reassess and remove this patch when upgrading the dependency pins. Generate future settings migrations with `pnpm exec drizzle-kit generate --config packages/storage/drizzle.config.ts`; Drizzle owns the only migration history.
