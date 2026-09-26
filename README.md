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

In development, macOS attributes permissions to "Electron", so you grant Microphone and Accessibility to Electron once. The packaged app asks as Voice.

## Check

```sh
pnpm fmt:check
pnpm lint
pnpm typecheck
pnpm test
swift test --package-path native/voice-helper
```

`pnpm fmt` fixes formatting. The pre-commit hook formats staged files.

## End to end

```sh
pnpm e2e
```

`pnpm e2e` builds the helper, the audio fixtures, and the app, then drives the built app through the real hotkey path without a microphone. It posts a synthetic Fn press, streams a fixture WAV through the helper instead of the microphone, and reads the inserted text back from a TextEdit document and from a scratch Electron window. It prints one JSON line per case with the session timings.

It needs Accessibility granted to the app that launches it, such as your terminal or IDE, and it briefly brings TextEdit to the front. It uses a throwaway userData directory and links the models from `~/Library/Caches/Voice Development/test-models`, or from `VOICE_TEST_MODELS_DIR` when set. The first run downloads about 950 MB of models into that directory.

`node scripts/idle-footprint.mjs` launches the built app the same way, waits for both models and 10 more seconds, then prints the average RSS and CPU of each process in the app's tree over 20 seconds.

## Package

```sh
pnpm dist:mac
```

This builds the helper in release mode and writes an arm64 DMG to `apps/desktop/release`.

## Website

`apps/web` is the download page. It is an Astro site that runs on Cloudflare Workers. On each request, it reads the stable update feed and links the current DMG. If the feed is unavailable, the button links to the latest GitHub release.

```sh
pnpm --filter @voice/web dev
pnpm --filter @voice/web build
pnpm --filter @voice/web preview
pnpm --filter @voice/web run deploy
```

`preview` serves the output of `build` locally in workerd, the Workers runtime. `deploy` builds and runs `wrangler deploy`. It needs `wrangler login` or a `CLOUDFLARE_API_TOKEN` in the environment.

The Deploy website workflow deploys the site when a push to `main` changes `apps/web` or the workspace dependencies. Run it manually from GitHub Actions to redeploy. It needs a `CLOUDFLARE_API_TOKEN` repository secret that can edit Workers scripts and the `voice.codlume.com` custom domain, and a `CLOUDFLARE_ACCOUNT_ID` repository variable. A new Voice release needs no deploy, because the page reads the stable feed on each request.
