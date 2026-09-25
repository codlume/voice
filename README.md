# Voice

Voice is a macOS dictation app. Hold a shortcut, speak, and release. Voice transcribes your speech on your Mac and types the text into the app you were using.

## Requirements

- A Mac with Apple Silicon.
- Xcode Command Line Tools (`xcode-select --install`). They provide Swift for the native helper.
- Node `24.21.0`. The version is in `.node-version`.
- pnpm `11.10.0`. The version is pinned in `package.json` under `packageManager`.

You do not need to install pnpm 11 globally. Use one of these:

- `corepack pnpm <command>` downloads and runs the pinned version.
- A global pnpm 9.12 or later switches to the pinned version inside this repository.
- `vp install` from [Vite+](https://viteplus.dev) installs with the pinned version.

## Develop

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds the Swift helper, starts the renderer dev server on port 5783, and opens the Voice window and the floating pill. Renderer edits reload in place. Main-process and preload edits restart Electron. To pass flags to Electron, add them after `--`, for example `pnpm dev -- --remote-debugging-port=9333`. Press Ctrl+C or quit Voice to stop everything `pnpm dev` started.

## Check

```sh
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm test
swift test --package-path native/voice-helper
```

`pnpm fmt` fixes formatting. The pre-commit hook formats staged files.

## Package

```sh
pnpm dist:mac
```

This builds the helper in release mode and writes an arm64 DMG to `apps/desktop/release`.
