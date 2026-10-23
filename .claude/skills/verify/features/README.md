# Voice verification map

This directory is the maintained list of what a user can do in Voice and how to prove each behavior through `voice-verify.mjs`. Read this index first, then use the feature's file as the recipe.

## Asserted dictation commands

The `vv scenario <name>` commands assert dictation end to end in their own disposable instance. [Asserted scenarios](../SKILL.md#asserted-scenarios) in the skill lists them with their prerequisites and evidence. A scenario proves a dictation effect, not the dialogs in the recipes below, and running one does not mark a recipe as run.

## Baseline preconditions

- Fresh builds: `swift build --package-path native/voice-helper`, `node scripts/fixtures.mjs`, `pnpm build`.
- For interactive recipes, one instance started by `voice-verify.mjs launch`, with `doctor` reporting `built` everywhere, both pages on CDP, both models `ready`, and Accessibility `granted`. Scenarios own their launch instead.
- Scratch userData only. Never drive the user's Voice.app or a `pnpm dev` session.
- The default settings apply: hotkey `fn`, cleanup on, styles Personal casual and the rest formal, language `en`.

## Driving conventions

- In this map, `vv` is shorthand for `node .claude/skills/verify/scripts/voice-verify.mjs`. Type the full command in a shell.
- `<userData>` is the instance's scratch folder, printed as `userData` by `launch` and `doctor`.
- Click by accessible name (`vv click "Show in Dock"`). Use `css:#setting-…` only for selects and unlabeled controls.
- After each click, wait on an observable change (`vv wait hub '…'`). Don't sleep.
- A recipe that changes settings leaves the instance changed. Revert the setting, or `stop` and relaunch before the next recipe.

## Proof and skip reporting

- Proof is the action plus the resulting state: `shot` before and after, plus `text`, `snapshot`, or the `dictate` JSON.
- Mutations also need a second view of the stored value: `<userData>/settings.json`, files under `<userData>/models`, or the target textarea.
- Record the feature ID and the entry point with every artifact (`vv note <feature> …`).
- If an entry point is unreachable, report the command you tried and the unmet precondition, for example "dictate refused: Voice.app running". Don't count it as verified through another path.

## Feature entry contract

Each file has an H1, one paragraph on user-visible behavior, then exactly these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with voice-verify`, `Gotchas`. Keep implementation details out. Name user paths, handles, required state, commands, and observable proof.

## Features

- [Dictation](./dictation.md): hold the hotkey, speak, release, and the text lands in the focused app. Covers cleanup on and off, Escape, too short, silence, and the Flow Bar states. `scenario short-dictation` and `scenario cleanup-failure` proved toggle insertion, raw fallback, and subsequent cleanup recovery on 2026-10-20.
- [Style](./style.md): turn cleanup on or off and choose a writing style for each of Personal messages, Work messages, Email, and Other, applied by the app or website you dictate into. The cleanup switch was proven end to end on 2026-10-03, the banners on 2026-10-16, and the tabs, assignments, and the `dictate --app` recipe on 2026-10-22.
- [Transforms](./transforms.md): select text in any app, press Option+1 or Option+2, and Voice rewrites the selection in place on the Mac. Covers the Transforms switch, cancel with Escape, the refusals, the shortcut picker, the After dictation choice, and the Last transform panel. Not yet run end to end with `vv transform`.
- [Snippets](./snippets.md): save a spoken trigger and the exact text Voice types in its place, then add, edit, validate, and delete snippets from the Snippets page. Add, validate, restart persistence, edit, and delete are proven with `voice-verify`. `scenario snippet-expansion` proved exact expansion in the dictation target with API setup on 2026-10-20.
- [Dictionary](./dictionary.md): save words Voice writes with their saved spelling, ignoring case and accents, and replacements that swap a phrase for saved text, from the Dictionary page. Add, validate, the snippet guard in both directions, edit, and delete are proven with `voice-verify`. `scenario dictionary-word` proved saved spelling in the dictation target with API setup on 2026-10-20.
- [Insights](./insights.md): pace, words, fixes, streaks, the daily heatmap, and where you dictate from the Insights page, kept across restarts, and cleared from Settings > Data and Privacy. Proven with `voice-verify` on 2026-10-22.
- [History](./history.md): transcripts on Home, grouped by day, with copy, copy raw, delete, and search, plus the tray's `Copy last transcript`. Kept in memory by default; Settings > Data and Privacy can save it on this Mac for 24 hours, 30 days, or forever, and clear it. Proven in the preview harness, and the copy, search, delete, memory, 30-day relaunch, back-to-memory, and clear recipes ran with `voice-verify` on 2026-10-22.
- [Models](./models.md): see, install, and uninstall the speech and cleanup models from Settings > Models and the Home checklist. The S1-mini recipes, including the stalled download, ran with `voice-verify` on 2026-10-22.
- [Settings](./settings.md): General, System, Shortcuts, and Data and Privacy controls, and resetting a row to its default.
- [Account](./account.md): sign in with Google from Settings > Account through the pasted code against a local API Worker, cancel, errors, staying signed in across a restart and offline, an expired or revoked auth session, and the unavailable state. Proven end to end on 2026-10-03.

Not mapped yet: the Home setup checklist and permission prompts, update check, download, and restart (About card, sidebar update card, and tray), quit and relaunch (`node scripts/quit-smoke.mjs`), and keyboard navigation in the Voice window.
