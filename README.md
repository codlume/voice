# Voice

Voice is a system-wide dictation app in development. This first slice provides a macOS settings window with a persistent appearance preference. Dictation, permissions, shortcuts, and provider setup are not available yet.

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

Renderer tests use a simulated preload. Desktop smoke tests launch the actual packaged Electron runtime, storage worker, SQLite migrations, and Swift helper. They use synthetic preferences and injected failures, never microphone capture or live providers. These checks do not establish native dictation or target-app compatibility.

The pre-commit hook formats staged files only. CI runs `Check`, `Test`, and `macOS Desktop`; no signing or publishing jobs are configured.

## Pinned storage compatibility

`patches/drizzle-orm@1.0.0-rc.4.patch` keeps the accepted Drizzle/Effect/TypeScript pins usable together. It changes the renamed Effect `TaggedErrorClass` API to `TaggedError`, restores column/role declarations omitted from Drizzle's published types but present in its source maps, removes invalid covariance annotations, and removes a stripped internal field from SQLite's excluded-method union. Both module formats are patched. Strict library checking stays enabled.

The storage tests exercise the patched import, migration, query, update, failure, and close/reopen paths. Reassess and remove this patch when upgrading the dependency pins. Generate future settings migrations with `pnpm exec drizzle-kit generate --config packages/storage/drizzle.config.ts`; Drizzle owns the only migration history.
