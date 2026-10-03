# Voice verification map

This directory is the maintained list of what a user can do in Voice and how to prove each behavior through `voice-verify.mjs`. Read this index first, then use the feature's file as the recipe.

## Baseline preconditions

- Fresh builds: `swift build --package-path native/voice-helper`, `node scripts/fixtures.mjs`, `pnpm build`.
- One instance started by `voice-verify.mjs launch`, with `doctor` reporting `built` everywhere, both pages on CDP, both models `ready`, and Accessibility `granted`.
- Scratch userData only. Never drive the user's Voice.app or a `pnpm dev` session.
- The default settings apply: hotkey `fn`, cleanup on, styling `semi-formal`, language `en`.

## Driving conventions

- In this map, `vv` is shorthand for `node .claude/skills/verify/scripts/voice-verify.mjs`. Type the full command in a shell.
- Click by accessible name (`vv click "Show in Dock"`). Use `css:#setting-…` only for selects and unlabeled controls.
- After each click, wait on an observable change (`vv wait hub '…'`). Don't sleep.
- A recipe that changes settings leaves the instance changed. Revert the setting, or `stop` and relaunch before the next recipe.

## Proof and skip reporting

- Proof is the action plus the resulting state: `shot` before and after, plus `text`, `snapshot`, or the `dictate` JSON.
- Mutations also need a second view of the stored value: `$TMPDIR/voice-verify/settings.json`, files under `$TMPDIR/voice-verify/models`, or the target textarea.
- Record the feature ID and the entry point with every artifact (`vv note <feature> …`).
- If an entry point is unreachable, report the command you tried and the unmet precondition, for example "dictate refused: Voice.app running". Don't count it as verified through another path.

## Feature entry contract

Each file has an H1, one paragraph on user-visible behavior, then exactly these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with voice-verify`, `Gotchas`. Keep implementation details out. Name user paths, handles, required state, commands, and observable proof.

## Features

- [Dictation](./dictation.md): hold the hotkey, speak, release, and the text lands in the focused app. Covers cleanup on and off, Escape, too short, silence, and the Flow Bar states.
- [Style](./style.md): turn cleanup on or off and choose the writing style. Proven end to end on 2026-10-03, when this skill was generated.
- [Last dictation](./last-dictation.md): view and copy the last transcript, raw or cleaned, from Home or the tray.
- [Models](./models.md): see, install, and uninstall the speech and cleanup models from Settings > Models and the Home checklist.
- [Settings](./settings.md): General, System, Shortcuts, and Data and Privacy controls.
- [Account](./account.md): sign in with Google from Settings > Account through the pasted code against a local API Worker, cancel, errors, staying signed in across a restart and offline, an expired or revoked auth session, and the unavailable state. Proven end to end on 2026-10-03.

Not mapped yet: the Home setup checklist and permission prompts, update check, download, and restart (About card, sidebar update card, and tray), quit and relaunch (`node scripts/quit-smoke.mjs`), and keyboard navigation in the Voice window.
