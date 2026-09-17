# Voice

## Agent skills

### Issue tracker

Use GitHub Issues. Before reading or publishing issues, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the default triage labels and the additional `spec` label. Before labeling issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout. Before exploring the codebase, read `docs/agents/domain.md`.

Voice is a minimal system-wide voice-to-text app. It captures speech, transcribes it, optionally cleans it up, and inserts the result into whatever app currently owns text focus.

Think of it as a fast dictation layer for the desktop: press a shortcut, speak, release, and keep typing.

## What makes Voice special?

These are the things we should not compromise on.

### 1. Fast enough to disappear

Dictation should feel closer to typing than to submitting a form. Startup, recording, transcription, cleanup, and insertion all belong to one latency budget.

Measure the real path. Do not hide slow work behind animation.

### 2. Works where the user already types

The product is useful because it is system-wide. Browsers, editors, terminals, chat apps, email, and native apps all matter.

A feature that only works inside our own window is usually incomplete.

### 3. Speech stays under user control

Recording begins only after explicit user intent. Audio, transcripts, clipboard contents, and surrounding app context are sensitive.

Collect, retain, and send the minimum data required for the feature.

### 4. Providers are replaceable

ASR and cleanup models will change. Keep vendor-specific behavior at adapter boundaries so the core recording and insertion flow stays stable.

## A note to agents

Favor ambitious outcomes and simple systems. Do not preserve complexity because it already exists, and do not introduce machinery because it looks architecturally impressive.

Understand the real constraint, then implement the smallest model that makes the correct behavior unsurprising. Fight scope creep.

The rules below are strong defaults. Explicit developer instructions win.

## A small glossary

Use this language consistently:

- **user** — the person dictating text.
- **session** — one shortcut-triggered dictation cycle.
- **capture** — microphone audio collected during a session.
- **ASR provider** — the local or remote speech-to-text engine.
- **partial** — transcript text that may still change.
- **final transcript** — provider-stable text for the session.
- **cleanup** — conservative post-processing after transcription.
- **insertion** — writing the result into the focused app.
- **target** — the app or editable control that should receive text.
- **dictionary** — user-defined words, names, acronyms, or replacements.

## The three ways to hurt yourself

1. **Recording without clear intent.** Never start or continue microphone capture because of stale shortcut state, focus changes, reconnects, or app startup.
2. **Losing user data.** Never discard a transcript because cleanup or insertion failed. Be especially careful when using the clipboard as a fallback.
3. **Putting slow work on the hot path.** Shortcut handling and capture startup must not wait on model loading, network setup, database work, or heavy UI rendering.

## Hit every surface

The most common defect is fixing one path while leaving another inconsistent. Before calling a feature done, check what applies:

- **Entry points.** Shortcut, menu bar/tray, main window, Settings, and onboarding may expose the same behavior.
- **Platforms.** macOS and Windows differ in shortcuts, permissions, accessibility APIs, audio devices, and text insertion.
- **Providers.** Provider-shaped changes need a decision for every ASR or cleanup adapter, even if the answer is “not supported”.
- **States.** If you add a way into a state, add a reliable way out. Recording, cancelling, retrying, and recovering must not become one-way doors.
- **Offline/degraded mode.** Network loss, provider failure, device changes, and permission revocation are normal runtime states.
- **Docs.** Update guidance only when the user or maintainer would otherwise make the wrong decision.

## Development safety

- Never test against private user recordings when synthetic or licensed fixtures will do.
- Never commit API keys, provider credentials, transcripts, audio captures, or clipboard dumps.
- Do not point development builds at production storage unless explicitly asked.
- If you start a process, track exactly what you started and stop only that process.
- Avoid tools that capture the whole screen, microphone, or active app unless the task actually requires them.

## Test data

An empty happy path is a bad test.

Keep a small deterministic fixture set that covers:

- short and long dictation,
- pauses and false starts,
- punctuation and paragraph boundaries,
- names, acronyms, numbers, dates, and URLs,
- background noise,
- microphone disconnects,
- provider timeouts,
- cleanup failure,
- insertion failure,
- offline behavior.

Fixtures must be synthetic, generated for testing, licensed, or explicitly approved for repository use.

## Verifying

Use the smallest proof that the change works.

- Run focused tests for the behavior you changed.
- Prefer observable behavior over tests that mirror implementation details.
- Do not rely on arbitrary sleeps for async state when a real signal can be awaited.
- Backend or native behavior changes should ship with focused tests where practical.
- Do not run repo-wide checks unless requested; CI owns the broad sweep.
- For user-visible dictation changes, the meaningful integrated flow is `shortcut -> speak -> transcript -> insert`.

## Pull requests

- Never create a PR unless the developer explicitly asks.
- Keep one concern per PR.
- Use plain-language conventional commit titles when the repo follows that convention.
- Describe the problem first, then the fix.
- UI changes should include before/after evidence when useful - github-image-upload.
- Timing, capture, or insertion bugs should include reproduction steps precise enough to verify the behavior.

## Documentation

Most code changes do not need a documentation change. Agents can read code.

- Internal docs are for cross-cutting decisions, durable constraints, and traps that are hard to discover from source.
- Do not document every field, method, state, or control flow.
- Put local implementation reasoning near the code.
- Rewrite stale guidance instead of appending a second version of the truth.
- User docs should explain tasks, permissions, shortcuts, provider choices, and unintuitive behavior without exposing internal implementation details.

## Plans and work artifacts

- Do not commit scratch notes, temporary plans, benchmark dumps, captured audio, or debugging transcripts.
- Track active work in the issue or project item that owns it when one exists.
- A merged PR is the implementation record; avoid maintaining a second permanent checklist.

## How it works

A session starts from explicit user input, usually a global shortcut. The app captures microphone audio and streams or submits it to an ASR adapter. The adapter emits partial and final transcript events. Optional cleanup transforms the final text without changing its meaning. An insertion adapter then writes the result into the previously focused target, falling back safely when direct insertion is unavailable.

Keep this pipeline conceptually simple:

`shortcut -> capture -> ASR -> cleanup -> insertion`

Failures must preserve the best transcript we have.

## Where complexity belongs

- **Capture adapters** own OS and audio-device details.
- **ASR adapters** own provider protocols, streaming formats, retries, and authentication.
- **Cleanup adapters** own model-specific prompting or deterministic normalization.
- **Insertion adapters** own accessibility APIs, paste fallback, and platform quirks.
- **Orchestration** owns session state and sequencing, not vendor-specific details.
- **UI** renders state and sends commands; it should not own transcription logic.

Anything crossing process boundaries should use explicit typed contracts.

## Performance

Users notice latency immediately.

Watch:

- shortcut-to-capture latency,
- time to first audio frame,
- time to first partial,
- finalization latency,
- cleanup latency,
- insertion latency,
- idle CPU and memory,
- unnecessary waveform or animation work.

Idle should actually mean idle. Avoid continuously repainting UI that has no user value.

## Taste

- Complexity belongs at adapter boundaries. Keep orchestration boring.
- Prefer explicit session states over combinations of unrelated booleans.
- Prefer inferred types; avoid `any`.
- Comments explain intent, constraints, and usage, not line-by-line behavior.
- Do not turn dictation into a general AI assistant unless explicitly requested.
- Do not silently use surrounding document, selection, clipboard, or screen context.
- If a rule here conflicts with the task, call it out and get human sign-off before breaking it.

## Additional tips

- Treat microphone and accessibility permissions as normal product states: not requested, granted, denied, revoked, or unavailable.
- Never show “listening” unless capture is actually active.
- Never show “inserted” unless insertion really succeeded or the fallback is explicit.
- Prefer direct native insertion where reliable; if clipboard fallback is used, avoid destroying unrelated clipboard contents.
- Preserve raw transcript text long enough to recover from cleanup or insertion failure, but do not persist it by default.
- Optimize the core loop before adding secondary AI features.
