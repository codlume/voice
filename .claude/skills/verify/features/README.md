# Voice verification map

This map lists the flows a user can run in Voice. Each row names the live check, the focused tests, and the proof to attach to the PR. Read it first, then follow the recipe in the feature's file. [SKILL.md](../SKILL.md#drive) describes every `vv` command.

## Get a clean instance first

- Build fresh: `swift build --package-path native/voice-helper`, `node scripts/fixtures.mjs`, then `pnpm build`.
- For interactive recipes, start one instance with `vv launch`. `vv doctor` must report `built` everywhere, both pages on CDP, both models `ready`, and Accessibility `granted`. A `vv scenario` run starts and stops its own instance instead.
- Use scratch userData only. Never drive the user's Voice.app or a `pnpm dev` session.
- The instance starts on the default settings: hotkey `fn`, cleanup on, Personal casual and the other styles formal, language `en`.

## Conventions

- `vv` is short for `node .claude/skills/verify/scripts/voice-verify.mjs`. Type the full command, because zsh does not split a variable into words.
- `<userData>` is the scratch folder that `launch` and `doctor` print as `userData`.
- Click by accessible name (`vv click "Show in Dock"`). Use `css:#setting-…` only for selects and unlabeled controls.
- After each action, wait on an observable change with `vv wait`. Don't sleep.
- A recipe that changes a setting leaves the instance changed. Revert the setting, or `stop` and relaunch, before the next recipe.
- A **bold** name in the Live check column is a recipe in the feature's file.
- Run tests from the repo root. A path under `apps/<name>` or `packages/<name>` runs with `pnpm --filter @voice/<name> exec vp test run <path inside that folder>`. A `.mjs` test runs with `node --test <path>`. `swift: <Name>` runs with `swift test --package-path native/voice-helper --filter <Name>`.

## Proof and skips

- Prove the action and the state it leaves: `vv shot` before and after, plus `vv text`, `vv snapshot`, or the command's JSON.
- For a flow with several steps, such as a dialog, a sign-in, or a drag, film the hub with `vv record <name>` in the background, then `kill -TERM` the pid it prints. `record` films only the hub. Capture the Flow Bar and the notepad with `vv shot <name> pill` and `vv shot <name> notepad`.
- Show a stored change a second way: `<userData>/settings.json`, a file under `<userData>/models` or `<userData>/meetings`, or the target textarea.
- Tag each artifact with the flow and the entry point: `vv note <feature> …`.
- Artifacts land in the evidence dir that `launch` and `stop` print. Upload the PNGs and MP4s to the PR. Never commit them.
- If an entry point is unreachable, report the command you tried and the unmet precondition, for example "dictate refused: Voice.app running". Don't count it as verified through another path.
- A `vv scenario` proves a dictation effect in its own instance. It does not prove a recipe's dialogs, and it does not count as running the recipe.
- When a feature file records the last live run of its recipes, the record is in its Gotchas.

## Feature entry contract

Each feature file has an H1, one paragraph on user-visible behavior, then exactly these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with voice-verify`, `Gotchas`. Keep implementation details out. Name user paths, handles, required state, commands, and observable proof.

## Features

### Dictation

Recipes: [dictation.md](./dictation.md#driving-it-with-voice-verify). State chart: [statecharts/dictation.md](../statecharts/dictation.md). `dictate` needs `otherVoiceProcesses: []` in `vv doctor`.

| Flow                        | Live check                                                                       | Tests                                                                                          | Proof                                                      |
| --------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Insert with cleanup         | `vv scenario short-dictation`, or `vv dictate short.wav`                         | `apps/desktop/src/main/session.test.ts`, `apps/desktop/src/main/dictation.test.ts`             | `dictate` JSON with `outcome.kind` `inserted`              |
| Cleanup fails, raw inserted | `vv scenario cleanup-failure`                                                    | `apps/desktop/src/main/dictation.test.ts`                                                      | Scenario `PASS` report                                     |
| Raw insert                  | **Raw insert**                                                                   | `apps/desktop/src/main/dictation.test.ts`                                                      | JSON with `inserted` equal to `latest.raw`, no `cleanupMs` |
| Toggle key                  | **Toggle**                                                                       | `apps/desktop/src/main/dictation.test.ts`, `swift: HotkeyTests`                                | JSON with `mode` `toggle`                                  |
| Cancel, too short, silence  | `vv dictate short.wav --end=escape`, `--end=immediate`, `vv dictate silence.wav` | `apps/desktop/src/main/session.test.ts`                                                        | JSON with `idle`, `tooShort`, or `empty` and no `inserted` |
| Flow Bar states             | **Flow Bar**                                                                     | `apps/desktop/src/renderer/pillView.test.ts`, `apps/desktop/src/renderer/PillCapsule.test.tsx` | `vv shot … pill` for `listening`, `processing`, `inserted` |
| Target app                  | **Target app**                                                                   | `apps/desktop/src/main/dictation.test.ts`                                                      | JSON with `app` and `outcome.kind` `inserted`              |
| TextEdit target             | `vv stop`, then `pnpm e2e`                                                       | None                                                                                           | `pnpm e2e` output                                          |
| Not inserted                | `node native/voice-helper/scripts/focus-smoke.mjs`. No `vv` recipe.              | `swift: TargetFocusTests`                                                                      | Smoke output                                               |

### Style

Recipes: [style.md](./style.md#driving-it-with-voice-verify).

| Flow                      | Live check                                       | Tests                                                                                                | Proof                                                  |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Cleanup off and on        | **Turn cleanup off**, **Turn cleanup on**        | `apps/desktop/src/main/cleanup.test.ts`                                                              | `vv shot style-cleanup-off`, `settings.json` `cleanup` |
| Pick a style per category | **Pick a style**                                 | `apps/desktop/src/shared/style.test.ts`                                                              | `settings.json` `cleanup.styles`                       |
| Assign an app or website  | **Assign an app**, **Add a website**, **Remove** | `apps/desktop/src/renderer/StyleAssignments.test.tsx`, `apps/desktop/src/renderer/styleView.test.ts` | `vv record`, `settings.json` `cleanup.assignments`     |
| Style by target           | **Style by target**                              | `apps/desktop/src/main/dictation.test.ts`, `packages/cleanup/src/style.test.ts`                      | One `dictate` JSON per `--app`                         |

### Transforms

Recipes: [transforms.md](./transforms.md#driving-it-with-voice-verify). State chart: [statecharts/transforms.md](../statecharts/transforms.md). Needs `optionalTestModels.transform: "cached"` in `vv doctor`. The last real-app run was at commit adad582a.

| Flow                                | Live check                                                                                                        | Tests                                                                                     | Proof                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Turn Transforms on                  | **Turn on**                                                                                                       | `apps/desktop/src/renderer/transformsView.test.ts`                                        | `settings.json` `transforms.enabled`                                 |
| Run by copy and by accessibility    | `vv transform`, `vv transform --target=textedit`                                                                  | `apps/desktop/src/main/transform-run.test.ts`, `apps/desktop/src/main/transforms.test.ts` | `transform` JSON with `clipboardUnchanged: true` and the `via=` line |
| Cancel with Escape before the write | `vv transform --escape`                                                                                           | `apps/desktop/src/main/transform-run.test.ts`                                             | JSON with `cancelled` and `after` equal to `before`                  |
| Refusals and write guard            | `vv stop`, then `node native/voice-helper/scripts/selection-smoke.mjs electron` and `… textedit`. No `vv` recipe. | `swift: SelectionTests`                                                                   | Smoke output                                                         |
| Record a shortcut                   | **Record a shortcut**                                                                                             | `apps/desktop/src/renderer/ShortcutPicker.test.tsx`                                       | `vv record`, then `vv transform --shortcut=20` JSON                  |
| Last transform panel                | **Last transform**                                                                                                | `apps/desktop/src/main/transforms.test.ts`                                                | `vv text`, `pbpaste` against `lastTransform.after`                   |

### Meetings

Recipes: [meetings.md](./meetings.md#driving-it-with-voice-verify). State chart: [statecharts/meetings.md](../statecharts/meetings.md). Recording is built. The page's `Start meeting` button, the tray item, and ⌥M each start a meeting. Test mode reads fixture WAVs, so a run proves files, transcription, echo, and lifecycle, not devices or permissions. The echo gate last ran live on 2026-11-03, and the notepad, Flow Bar, and recovery on 2026-10-31.

| Flow                                | Live check                                           | Tests                                                                                                                        | Proof                                                                                   |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Page, settings, folders             | **Open Meetings**, **Settings**, **Folders**         | `apps/desktop/src/renderer/Meetings.test.tsx`, `apps/desktop/src/main/meetings-store.test.ts`                                | `vv shot meetings-empty`, `<userData>/meetings/settings.json`, `folders.json`           |
| List, search, detail layout         | **Layout with meetings** (preview harness)           | `apps/desktop/src/renderer/meetingsView.test.ts`                                                                             | Shots of the preview scenes. Layout only.                                               |
| Record, live transcript, final pass | `vv meeting`                                         | `apps/desktop/src/main/meeting-recorder.test.ts`, `apps/desktop/src/main/meeting-final-pass.test.ts`, `swift: MeetingsTests` | `meeting` JSON with the transcript and only `meeting.json` and `transcript.ndjson` left |
| Echo and user lines                 | **Echo and user lines**                              | `swift: EchoGateTests`, `.claude/skills/verify/scripts/meeting-score.test.mjs`                                               | `final.echoKept` empty, `echoWords` 0, user words match the clean control               |
| Two speakers                        | **Two speakers**                                     | `swift: MeetingFinalPassTests`                                                                                               | `speakers` lists `s1` and `s2`                                                          |
| Start and stop from tray or ⌥M      | **Tray**, **Shortcut in the Voice window**           | `apps/desktop/src/main/hub-commands.test.ts`, `apps/desktop/src/renderer/useShortcuts.test.tsx`                              | `vv tray` output before and after                                                       |
| Notepad and Flow Bar                | **Notepad and Flow Bar**                             | `apps/desktop/src/renderer/MeetingNotepad.test.tsx`, `apps/desktop/src/main/notepad-window.test.ts`                          | `vv shot … notepad`, `vv shot … pill`                                                   |
| Dictation mid-meeting               | Dictation mid-meeting, in the recipes                | `apps/desktop/src/main/meeting-recorder.test.ts`                                                                             | `dictated` marker in the transcript                                                     |
| Recovery after a quit               | Recovery, in the recipes                             | `apps/desktop/src/main/meeting-lifecycle.test.ts`                                                                            | Status `ready` after relaunch, folder listing                                           |
| Silence and length prompts          | No live recipe. They need 10 and 25 or more minutes. | `apps/desktop/src/main/meeting-focus.test.ts`, `apps/desktop/src/renderer/MeetingNotepad.test.tsx`                           | Test output                                                                             |
| Audio lost                          | No live recipe. Test mode cannot produce it.         | `apps/desktop/src/main/meeting-lifecycle.test.ts`, `apps/desktop/src/main/meeting-focus.test.ts`                             | Test output                                                                             |
| Set up Meetings card                | Preview scene `preview.html?hub=meetings-setup`      | `apps/desktop/src/renderer/MeetingsSetup.test.tsx`, `apps/desktop/src/renderer/checklist.test.ts`                            | Shot. Layout only.                                                                      |

### Snippets

Recipes: [snippets.md](./snippets.md#driving-it-with-voice-verify).

| Flow                                        | Live check                                                           | Tests                                                                                                                                       | Proof                                   |
| ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Add, format, validate, edit, toggle, delete | **Add**, **Format**, **Duplicate**, **Edit**, **Toggle**, **Delete** | `apps/desktop/src/shared/snippets.test.ts`, `apps/desktop/src/shared/snippet-html.test.ts`, `apps/desktop/src/renderer/snippetText.test.ts` | `vv record`, `settings.json` `snippets` |
| Expansion in dictation                      | `vv scenario snippet-expansion`                                      | `apps/desktop/src/shared/rewrite.test.ts`                                                                                                   | Scenario `PASS` report                  |

### Dictionary

Recipes: [dictionary.md](./dictionary.md#driving-it-with-voice-verify).

| Flow                        | Live check                                                                 | Tests                                                                                    | Proof                                     |
| --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| Add, validate, edit, delete | **Add a word**, **Add a replacement**, **Duplicate**, **Edit**, **Delete** | `apps/desktop/src/shared/dictionary.test.ts`                                             | `vv record`, `settings.json` `dictionary` |
| Snippet collision           | **Snippet collision**                                                      | `apps/desktop/src/shared/dictionary.test.ts`, `apps/desktop/src/shared/snippets.test.ts` | Shot of each message                      |
| Saved spelling in dictation | `vv scenario dictionary-word`                                              | `apps/desktop/src/shared/rewrite.test.ts`                                                | Scenario `PASS` report                    |

### Insights

Recipes: [insights.md](./insights.md#driving-it-with-voice-verify).

| Flow                | Live check                 | Tests                                                                                      | Proof                                                       |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Count a session     | **Count a session**        | `apps/desktop/src/main/insights.test.ts`, `apps/desktop/src/renderer/insightsView.test.ts` | `vv shot insights-counted`, `insights.json` with no words   |
| Where you dictate   | **Where you dictate**      | `apps/desktop/src/main/dictation.test.ts`                                                  | `vv shot insights-usage`, `insights.json` `apps`            |
| Heatmap by keyboard | **Heatmap by keyboard**    | `apps/desktop/src/renderer/insightsView.test.ts`                                           | `vv eval` output naming the focused day                     |
| Persist and clear   | **Persistence**, **Clear** | `apps/desktop/src/main/insights.test.ts`                                                   | Shots before and after, `ls <userData>/insights.json` fails |

### History

Recipes: [history.md](./history.md#driving-it-with-voice-verify).

| Flow                                         | Live check                                                                                          | Tests                                                                                         | Proof                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Row, copy, copy raw, search, delete          | **Row appears under Today**, **Click copies**, **Search**, **Delete**                               | `apps/desktop/src/renderer/History.test.tsx`, `apps/desktop/src/renderer/historyView.test.ts` | `vv shot history-row`, `pbpaste \| cmp` inside `vv clipboard save` and `restore` |
| Memory only                                  | **Memory only**                                                                                     | `apps/desktop/src/main/history.test.ts`                                                       | No `<userData>/history.json` after relaunch                                      |
| Saved window, back to memory, shorten, clear | **Saved across a relaunch**, **Back to memory deletes the file**, **Shorten asks first**, **Clear** | `apps/desktop/src/main/history.test.ts`, `apps/desktop/src/renderer/useHistory.test.tsx`      | `history.json` `retention` and mode `600`                                        |
| Copy last transcript from the tray           | No live recipe. `vv tray` lists the item, but `vv tray <id>` cannot choose it because it has no id. | None                                                                                          | `vv tray` output                                                                 |

### Models

Recipes: [models.md](./models.md#driving-it-with-voice-verify). State chart: [statecharts/models.md](../statecharts/models.md).

| Flow                                 | Live check                                                                          | Tests                                                                                                                      | Proof                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Status, uninstall, reinstall         | **Open**, **Cancel an uninstall**, **Uninstall**, **Reinstall without downloading** | `apps/desktop/src/renderer/modelView.test.ts`                                                                              | `vv shot models-installed`, `ls -l <userData>/models` |
| Stalled download and Cancel          | **Stalled download and Cancel**                                                     | `swift: ModelFetcherTests`, `apps/desktop/src/renderer/checklist.test.ts`                                                  | `vv record`, no `.part` file                          |
| Stalled speech download and Cancel   | **Stalled speech download and Cancel**                                              | `swift: ModelIntegrityTests`, `apps/desktop/src/renderer/modelView.test.ts`, `apps/desktop/src/renderer/checklist.test.ts` | `vv record`, no `parakeet-tdt-0.6b-v3` folder         |
| Speech model uninstall and reinstall | `vv stop`, then `node scripts/models-smoke.mjs`                                     | None                                                                                                                       | Script output                                         |

### Settings

Recipes: [settings.md](./settings.md#driving-it-with-voice-verify).

| Flow                       | Live check                                                              | Tests                                                                                                                          | Proof                       |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Switches, selects, reset   | **Toggle a switch**, **Pick from a select**, **Reset**                  | `apps/desktop/src/main/settings.test.ts`, `apps/desktop/src/main/settings-queue.test.ts`, `apps/desktop/src/main/dock.test.ts` | `settings.json` value, shot |
| Sliders                    | **Set the Reduce volume by slider**, **Set the Page animations slider** | `apps/desktop/src/renderer/CommitSlider.test.tsx`                                                                              | `settings.json` value       |
| Microphone test            | **Test the microphone** (fails by design; shows the fallback sentence)  | `apps/desktop/src/main/microphone-test.test.ts`, `apps/desktop/src/renderer/microphoneTestView.test.ts`                        | Test output                 |
| Lower audio on real output | `node native/voice-helper/scripts/output-lowering-smoke.mjs`            | `swift: OutputSuppressionTests`                                                                                                | Smoke output                |

### Account

Recipes: [account.md](./account.md#driving-it-with-voice-verify). State chart: [statecharts/account.md](../statecharts/account.md). Needs the verify Worker and `VOICE_API_URL=http://localhost:8787` on `launch`. The file's Gotchas list which recipes ran live and when.

| Flow                                 | Live check                                                                               | Tests                                                                                                                          | Proof                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Sign in by pasted code or callback   | **Sign in**, **Paste the code**, **Callback URL**, **Second instance**                   | `apps/desktop/src/main/account-sign-in.test.ts`, `apps/desktop/src/main/account-landing.test.ts`, `apps/api/test/auth.test.ts` | `vv record account-sign-in`, `vv snapshot \| grep -c token` prints 0 |
| Cancel, timeout, errors, interrupted | **Cancel**, **Timeout**, **Error**, **Stale code**, **Malformed paste**, **Interrupted** | `apps/desktop/src/main/account-sign-in.test.ts`, `apps/desktop/src/renderer/accountView.test.ts`                               | `vv shot account-error`, the `main.log` line                         |
| Name, picture, hidden email          | **Edit the name**, **Profile picture**, `account-email-hidden` in Sub-features           | `apps/desktop/src/main/account-name.test.ts`, `apps/desktop/src/main/account-picture.test.ts`                                  | Shots, `vv snapshot` `account`                                       |
| Restart, offline, expired or revoked | **Restart**, **Offline**, **Expired or revoked**                                         | `apps/desktop/src/main/account-client.test.ts`, `apps/desktop/src/main/account.test.ts`                                        | `signedIn` or `error` after relaunch, Worker log                     |
| Sign out                             | **Sign out**, **Offline sign-out**                                                       | `apps/desktop/src/main/account-sign-out.test.ts`                                                                               | Shots before and after, `config.json` cookie `null`                  |
| Delete account                       | **Delete confirmation and success**, **Stale deletion**, **Offline deletion**            | `apps/desktop/src/main/account-deletion.test.ts`                                                                               | Shots, zero rows for the user in local D1                            |
| Unavailable                          | **Unavailable**                                                                          | `apps/desktop/src/main/account.test.ts`                                                                                        | `vv text`                                                            |

### Home setup and permissions

No feature file yet.

| Flow               | Live check                                                                                                                        | Tests                                                                                    | Proof           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------- |
| Setup checklist    | **Home checklist** in [models.md](./models.md#driving-it-with-voice-verify), and preview scene `preview.html?hub=setup-not-ready` | `apps/desktop/src/renderer/checklist.test.ts`, `apps/desktop/src/renderer/Home.test.tsx` | `vv text`, shot |
| Permission prompts | No live recipe. The instance never reads the microphone, and only a human grants Accessibility.                                   | `swift: PermissionsTests`, `apps/desktop/src/renderer/checklist.test.ts`                 | Test output     |

### Updates

No feature file yet. A development build reports updates as `disabled`.

| Flow                     | Live check                                                                                                                                                                   | Tests                                                                                                                                         | Proof                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Check, download, restart | No live recipe. `vv tray` shows the update item with `enabled: false`. Preview scenes `?hub=available`, `?hub=downloading`, `?hub=ready`, and `?hub=failed` show the layout. | `apps/desktop/src/main/updates.test.ts`, `apps/desktop/src/renderer/updateStatus.test.ts`, `apps/desktop/src/renderer/RestartNotice.test.tsx` | `vv tray` output, preview shots |

### Quit and relaunch

No feature file yet.

| Flow                               | Live check                                                                                                                | Tests | Proof                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------- |
| Quit during model load and cleanup | `node scripts/quit-smoke.mjs`. No `vv` recipe.                                                                            | None  | Script output        |
| Relaunch keeps saved state         | `vv stop --keep-user-data`, then `vv launch --keep-user-data`, as the History, Insights, Meetings, and Account recipes do | None  | State after relaunch |

### Keyboard navigation

No feature file yet.

| Flow                | Live check                                                                                             | Tests                                                                                            | Proof              |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------ |
| Page jumps          | `vv key Digit<n> command` for n from 1 to 7, in the nav order that [SKILL.md](../SKILL.md#drive) lists | `apps/desktop/src/renderer/shortcuts.test.ts`, `apps/desktop/src/renderer/useShortcuts.test.tsx` | `vv text` nav line |
| Tab order and focus | No live recipe.                                                                                        | None                                                                                             | None               |
