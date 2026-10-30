# Changelog

## 0.21.0 (2026-10-30)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* feat(transforms): rewrite selected text or dictation with a local model by @hadrysm in https://github.com/codlume/voice/pull/315
* perf(transforms): cut the transform model's cold load by @hadrysm in https://github.com/codlume/voice/pull/317
* feat(settings): show transform shortcuts in Settings > Shortcuts by @hadrysm in https://github.com/codlume/voice/pull/318
* feat(audio): lower audio by a chosen percentage while dictating by @hadrysm in https://github.com/codlume/voice/pull/319
* feat(hub): glide the sidebar's active highlight between pages by @hadrysm in https://github.com/codlume/voice/pull/320
* feat(home): show top apps under the stats card by @hadrysm in https://github.com/codlume/voice/pull/321
* fix(apps): wait for the helper's app list instead of dropping it after 5 s by @hadrysm in https://github.com/codlume/voice/pull/322
* fix(dictation): keep the transcript when the helper exits mid-cleanup or mid-insert by @hadrysm in https://github.com/codlume/voice/pull/338
* fix(cleanup): keep camelCase, PascalCase, and brand casing under Very casual by @hadrysm in https://github.com/codlume/voice/pull/332
* fix(api): send a failed Google sign-in to the landing page by @hadrysm in https://github.com/codlume/voice/pull/333
* fix(web): send security headers on every page by @hadrysm in https://github.com/codlume/voice/pull/340
* fix(updates): offer the newer release when a background re-download fails by @hadrysm in https://github.com/codlume/voice/pull/337
* fix(helper): restore a late selection copy only when no press followed the deadline by @hadrysm in https://github.com/codlume/voice/pull/335
* fix(settings): keep an unreadable file and unknown keys across a save by @hadrysm in https://github.com/codlume/voice/pull/336
* fix(cleanup): learn the token rate per clean instead of keeping one slow measurement by @hadrysm in https://github.com/codlume/voice/pull/329
* fix(transforms): unload the model once a run in flight settles by @hadrysm in https://github.com/codlume/voice/pull/334
* fix(pill): say "Copied to clipboard" only when the session copied by @hadrysm in https://github.com/codlume/voice/pull/339
* fix(hub): ignore page shortcuts while a dialog owns the keyboard by @hadrysm in https://github.com/codlume/voice/pull/330
* fix(scripts): stop detached children when the terminal hangs up by @hadrysm in https://github.com/codlume/voice/pull/331
* fix(verify): stop a cached transform model from blocking every scenario by @hadrysm in https://github.com/codlume/voice/pull/341
* chore(deps): bump voidzero-dev/setup-vp from 1.21.1 to 1.21.2 in the github-actions group by @dependabot[bot] in https://github.com/codlume/voice/pull/323
* perf(helper): paste directly into apps that ignore AX writes by @hadrysm in https://github.com/codlume/voice/pull/343
* perf(helper): check AX inserts by length, not full text by @hadrysm in https://github.com/codlume/voice/pull/344
* perf(desktop): keep the auto-apply transform model loaded by @hadrysm in https://github.com/codlume/voice/pull/345
* fix(settings): set aside a file that was not JSON at launch before the first save by @hadrysm in https://github.com/codlume/voice/pull/347
* fix(cleanup): reject cleanups that change numbers, negations or add words by @hadrysm in https://github.com/codlume/voice/pull/346
* fix(release): launch the packaged app before publishing by @hadrysm in https://github.com/codlume/voice/pull/348
* fix(release): ship only runtime externals and no source maps in app.asar by @hadrysm in https://github.com/codlume/voice/pull/349
* fix(helper): compare the window title only after a press by @hadrysm in https://github.com/codlume/voice/pull/350
* fix(helper): refuse the insert when the page URL changed by @hadrysm in https://github.com/codlume/voice/pull/352
* fix(insights): show small usage shares instead of 0% by @hadrysm in https://github.com/codlume/voice/pull/353
* fix(insights): show small usage shares with at most two decimals by @hadrysm in https://github.com/codlume/voice/pull/354
* feat(desktop): open Settings as a modal over the current page by @hadrysm in https://github.com/codlume/voice/pull/355
* perf: measure the dictation path and cut release, startup and size costs by @hadrysm in https://github.com/codlume/voice/pull/357


**Full Changelog**: https://github.com/codlume/voice/compare/v0.20.2...v0.21.0

## 0.20.2 (2026-10-23)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* fix(release): force notarization stapling onto TCP by @hadrysm in https://github.com/codlume/voice/pull/313


**Full Changelog**: https://github.com/codlume/voice/compare/v0.20.1...v0.20.2

## 0.20.1 (2026-10-22)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* chore(agents): correct the verify map and add a front command by @hadrysm in https://github.com/codlume/voice/pull/309


**Full Changelog**: https://github.com/codlume/voice/compare/v0.20.0...v0.20.1

## 0.20.0 (2026-10-22)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* feat(desktop): let users turn individual snippets on and off by @hadrysm in https://github.com/codlume/voice/pull/260
* refactor(desktop): remove the other-channel account note by @hadrysm in https://github.com/codlume/voice/pull/262
* feat(account): edit first and last name on the Account page by @hadrysm in https://github.com/codlume/voice/pull/263
* fix(desktop): open a new snippet with an empty draft by @hadrysm in https://github.com/codlume/voice/pull/264
* feat(desktop): add a Dictionary that fixes spellings and swaps phrases by @hadrysm in https://github.com/codlume/voice/pull/265
* fix(desktop): use Worcestershire as the Dictionary example by @hadrysm in https://github.com/codlume/voice/pull/267
* fix(helper): count only presses in the focus input stamp by @hadrysm in https://github.com/codlume/voice/pull/268
* perf(helper): report capture start on the first audio, not the first 100 ms tick by @hadrysm in https://github.com/codlume/voice/pull/269
* perf(cleanup): keep the GPU busy while the transcript is being produced by @hadrysm in https://github.com/codlume/voice/pull/270
* feat(desktop): reset a setting to its default from Settings by @hadrysm in https://github.com/codlume/voice/pull/271
* feat(desktop): add dictionary entries with a Replace with other text switch by @hadrysm in https://github.com/codlume/voice/pull/272
* feat(snippets): paste formatted snippets as rich text by @hadrysm in https://github.com/codlume/voice/pull/273
* feat(desktop): edit snippets in a rich text editor by @hadrysm in https://github.com/codlume/voice/pull/274
* feat(desktop): add an Insights page with pace, fixes, words, and streaks by @hadrysm in https://github.com/codlume/voice/pull/276
* feat(desktop): redesign Home with session history and opt-in saved history by @hadrysm in https://github.com/codlume/voice/pull/277
* feat(desktop): add a toggle dictation key by @hadrysm in https://github.com/codlume/voice/pull/278
* refactor: remove dead code and duplicated helpers across the repo by @hadrysm in https://github.com/codlume/voice/pull/280
* test(cleanup): calibrate S1-mini stylings across general and email layouts by @hadrysm in https://github.com/codlume/voice/pull/283
* feat(cleanup): offer Formal, Casual and Very casual styles by @hadrysm in https://github.com/codlume/voice/pull/284
* feat(helper): report the target app and website host with each transcript by @hadrysm in https://github.com/codlume/voice/pull/285
* feat(desktop): style dictation by the app or website it goes into by @hadrysm in https://github.com/codlume/voice/pull/286
* feat(desktop): show the installed apps each style applies to by @hadrysm in https://github.com/codlume/voice/pull/287
* feat(desktop): assign any app or website to a style category by @hadrysm in https://github.com/codlume/voice/pull/288
* fix(desktop): drop the fix count that repeats the Insights total by @hadrysm in https://github.com/codlume/voice/pull/291
* fix(desktop): draw keycaps as a soft fill instead of an outline by @hadrysm in https://github.com/codlume/voice/pull/297
* feat(desktop): show where you dictate on Insights by @hadrysm in https://github.com/codlume/voice/pull/293
* feat(desktop): count words per app and category in Insights by @hadrysm in https://github.com/codlume/voice/pull/294
* feat(desktop): move the snippet on/off switch into its dialog by @hadrysm in https://github.com/codlume/voice/pull/296
* fix(desktop): keep checking for updates after one is offered by @hadrysm in https://github.com/codlume/voice/pull/298
* feat(desktop): show the notes of every skipped release by @hadrysm in https://github.com/codlume/voice/pull/299
* feat(desktop): group the Settings sidebar like Wispr Flow by @hadrysm in https://github.com/codlume/voice/pull/301
* feat(desktop): animate hub page changes by @hadrysm in https://github.com/codlume/voice/pull/302
* feat(desktop): add a Page animations duration setting by @hadrysm in https://github.com/codlume/voice/pull/303
* chore(agents): make verification safe and reproducible by @hadrysm in https://github.com/codlume/voice/pull/306
* fix(desktop): report helper crashes with their stack by @hadrysm in https://github.com/codlume/voice/pull/307
* fix(desktop): give every hub page the same container by @hadrysm in https://github.com/codlume/voice/pull/308


**Full Changelog**: https://github.com/codlume/voice/compare/v0.19.0...v0.20.0

## 0.19.0 (2026-10-11)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* feat(account): point Stable builds at the Stable API by @hadrysm in https://github.com/codlume/voice/pull/258


**Full Changelog**: https://github.com/codlume/voice/compare/v0.18.0...v0.19.0

## 0.18.0 (2026-10-11)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* feat(desktop): move update settings to General as About by @hadrysm in https://github.com/codlume/voice/pull/157
* chore(agents): add a verify skill that drives the desktop app by @hadrysm in https://github.com/codlume/voice/pull/160
* chore(agents): map Voice features for the verify skill by @hadrysm in https://github.com/codlume/voice/pull/161
* test(desktop): answer the in-window uninstall dialog in the Models smoke by @hadrysm in https://github.com/codlume/voice/pull/159
* fix(desktop): stop setting titles from hovering their select by @hadrysm in https://github.com/codlume/voice/pull/165
* feat(api): serve the health check on Nightly by @hadrysm in https://github.com/codlume/voice/pull/164
* feat(account): sign in with Google from the desktop by @hadrysm in https://github.com/codlume/voice/pull/166
* feat(desktop): stay signed in across restarts by @hadrysm in https://github.com/codlume/voice/pull/169
* feat(desktop): recover from an interrupted or failed sign-in by @hadrysm in https://github.com/codlume/voice/pull/168
* feat(account): sign out by @hadrysm in https://github.com/codlume/voice/pull/172
* feat(account): delete account by @hadrysm in https://github.com/codlume/voice/pull/171
* feat(account): ship accounts on Stable by @hadrysm in https://github.com/codlume/voice/pull/174
* fix(api): stop storing Google's ID token by @hadrysm in https://github.com/codlume/voice/pull/175
* feat(account): open Voice from the browser after sign-in, without pasting a code by @hadrysm in https://github.com/codlume/voice/pull/177
* fix(api): let the Worker reach its own sign-in route on Cloudflare by @hadrysm in https://github.com/codlume/voice/pull/179
* feat(dictation): copy the transcript to the clipboard after insertion by @hadrysm in https://github.com/codlume/voice/pull/181
* feat(desktop): show the Google profile picture in Account by @hadrysm in https://github.com/codlume/voice/pull/180
* feat(desktop): add an account menu to the titlebar by @hadrysm in https://github.com/codlume/voice/pull/182
* fix(desktop): strip the IPC wrapper from hub error messages by @hadrysm in https://github.com/codlume/voice/pull/184
* fix(desktop): give development builds their own Keychain item by @hadrysm in https://github.com/codlume/voice/pull/186
* fix(desktop): show main-process errors from hub settings, copy, and microphone test by @hadrysm in https://github.com/codlume/voice/pull/188
* feat(desktop): blur the account email until the user clicks it by @hadrysm in https://github.com/codlume/voice/pull/185
* feat(desktop): open the hub at Wispr Flow's size by @hadrysm in https://github.com/codlume/voice/pull/189
* feat(desktop): zoom the Voice window with Cmd+= and Cmd+- by @hadrysm in https://github.com/codlume/voice/pull/190
* chore(desktop): upgrade effect to 4.0.1 by @hadrysm in https://github.com/codlume/voice/pull/191
* feat(desktop): draw UI icons with lucide-react by @hadrysm in https://github.com/codlume/voice/pull/192
* fix(desktop): recover from an unreadable config.json and sync settings saves by @hadrysm in https://github.com/codlume/voice/pull/201
* ci: harden release workflows against compromised actions and dependencies by @hadrysm in https://github.com/codlume/voice/pull/202
* fix(helper,desktop): report a capture the helper stops on its own by @hadrysm in https://github.com/codlume/voice/pull/211
* fix(api): move the user and session sweeps to a Cron Trigger by @hadrysm in https://github.com/codlume/voice/pull/216
* ci: cut install and cache time in CI and deploy jobs by @hadrysm in https://github.com/codlume/voice/pull/214
* perf(helper): ask TCC for microphone status off the main thread by @hadrysm in https://github.com/codlume/voice/pull/215
* fix(api): route only Voice's auth paths and prune rate-limit rows off the request by @hadrysm in https://github.com/codlume/voice/pull/217
* fix(desktop): send the Flow Bar only what it renders by @hadrysm in https://github.com/codlume/voice/pull/203
* fix(desktop): keep a transcript that outlives the transcription watchdog by @hadrysm in https://github.com/codlume/voice/pull/204
* fix(helper): keep passwords and transcripts off the clipboard after a paste by @hadrysm in https://github.com/codlume/voice/pull/205
* perf(desktop): publish snapshots only when something changed by @hadrysm in https://github.com/codlume/voice/pull/206
* fix(desktop): unload cleanup when the dictation language turns it off by @hadrysm in https://github.com/codlume/voice/pull/207
* feat(desktop): lock both windows to the app's own pages by @hadrysm in https://github.com/codlume/voice/pull/208
* fix(cleanup): reject cleanups that drop the words the user said by @hadrysm in https://github.com/codlume/voice/pull/209
* perf(desktop): load electron-updater at the first update check by @hadrysm in https://github.com/codlume/voice/pull/210
* feat(desktop): flip Electron fuses and trim voice-helper entitlements by @hadrysm in https://github.com/codlume/voice/pull/212
* fix(desktop): scrub every Sentry item at the transport and record nothing while sharing is off by @hadrysm in https://github.com/codlume/voice/pull/213
* chore(deps): bump the github-actions group across 1 directory with 3 updates by @dependabot[bot] in https://github.com/codlume/voice/pull/228
* test(desktop): measure helper restart backoff on a fake clock by @hadrysm in https://github.com/codlume/voice/pull/239
* fix(desktop): sign the helper inside electron-builder's signing pass by @hadrysm in https://github.com/codlume/voice/pull/240
* fix(cleanup): cancel stalled model downloads by @hadrysm in https://github.com/codlume/voice/pull/250
* fix(verify): give each worktree its own verify instance by @hadrysm in https://github.com/codlume/voice/pull/229
* fix(auth): reduce sign-in consent-phishing exposure by @hadrysm in https://github.com/codlume/voice/pull/245
* fix(helper): preserve the capture tail and defer device teardown by @hadrysm in https://github.com/codlume/voice/pull/248
* fix(verify): match running Voice processes on the executable by @hadrysm in https://github.com/codlume/voice/pull/233
* fix(cleanup): preserve clause casing and paragraph breaks by @hadrysm in https://github.com/codlume/voice/pull/253
* fix(scripts): count only an open dialog in models-smoke by @hadrysm in https://github.com/codlume/voice/pull/234
* fix(desktop): isolate Flow Bar commands from the hub by @hadrysm in https://github.com/codlume/voice/pull/244
* fix(helper): restore muted outputs after a helper crash by @hadrysm in https://github.com/codlume/voice/pull/249
* perf(cleanup): retain finished chunks within the dictation budget by @hadrysm in https://github.com/codlume/voice/pull/254
* fix(scripts): launch TextEdit through open in e2e by @hadrysm in https://github.com/codlume/voice/pull/241
* fix(verify): report a capture that ends before the fixture does by @hadrysm in https://github.com/codlume/voice/pull/237
* fix(helper): preserve clipboard on unverified insertion by @hadrysm in https://github.com/codlume/voice/pull/251
* fix(verify): wait for pasted text in the target by @hadrysm in https://github.com/codlume/voice/pull/246
* perf(cleanup): move native model work off the main process by @hadrysm in https://github.com/codlume/voice/pull/255
* fix(helper): verify the captured field and window before insertion by @hadrysm in https://github.com/codlume/voice/pull/252
* fix(helper): restore the paste fallback for unverified insertion by @hadrysm in https://github.com/codlume/voice/pull/257
* feat(desktop): add snippets that expand spoken triggers into saved text by @hadrysm in https://github.com/codlume/voice/pull/256

## New Contributors
* @dependabot[bot] made their first contribution in https://github.com/codlume/voice/pull/228

**Full Changelog**: https://github.com/codlume/voice/compare/v0.17.0...v0.18.0

## 0.17.0 (2026-10-02)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* feat(web): add a terms of service page by @hadrysm in https://github.com/codlume/voice/pull/155


**Full Changelog**: https://github.com/codlume/voice/compare/v0.16.0...v0.17.0

## 0.16.0 (2026-10-02)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* feat(desktop): add a Models settings page to install and uninstall models by @hadrysm in https://github.com/codlume/voice/pull/122
* refactor(desktop): let the cleanup package own model removal by @hadrysm in https://github.com/codlume/voice/pull/134
* test(desktop): add an end-to-end smoke for the Models page by @hadrysm in https://github.com/codlume/voice/pull/135
* feat(desktop): send allowlisted app events to Sentry Logs by @hadrysm in https://github.com/codlume/voice/pull/139
* chore: add the Sentry MCP server for Claude Code and Codex by @hadrysm in https://github.com/codlume/voice/pull/138
* feat(desktop): add the update button next to Back in Settings by @hadrysm in https://github.com/codlume/voice/pull/140
* perf(helper): cache microphone authorization off the capture hot path by @hadrysm in https://github.com/codlume/voice/pull/148
* perf(cleanup): bisect chunk boundaries instead of re-tokenizing per word by @hadrysm in https://github.com/codlume/voice/pull/147
* fix(desktop): stop a cleanup model download when Voice quits by @hadrysm in https://github.com/codlume/voice/pull/146
* fix(cleanup): stop assertPlausibleCleanup from rejecting expanded openers and accepting lost text by @hadrysm in https://github.com/codlume/voice/pull/145
* fix(desktop): drop unscrubbed envelope items before they reach Sentry by @hadrysm in https://github.com/codlume/voice/pull/144
* fix(desktop): keep the start watchdog deadline and report every finished session by @hadrysm in https://github.com/codlume/voice/pull/143
* fix(helper): pick the paste key from the layout's Command table by @hadrysm in https://github.com/codlume/voice/pull/141
* fix(helper): end a live hold when the hotkey is reconfigured by @hadrysm in https://github.com/codlume/voice/pull/142
* ci(release): move release actions off the deprecated Node 20 runtime by @hadrysm in https://github.com/codlume/voice/pull/149
* feat(desktop): confirm model uninstall in a styled dialog by @hadrysm in https://github.com/codlume/voice/pull/150
* feat(web): add a privacy policy page by @hadrysm in https://github.com/codlume/voice/pull/152
* feat(desktop): download updates only when the user asks by @hadrysm in https://github.com/codlume/voice/pull/154


**Full Changelog**: https://github.com/codlume/voice/compare/v0.15.0...v0.16.0

## 0.15.0 (2026-10-01)

<!-- Release notes generated using configuration in .github/release.yml at main -->

## What's Changed
* feat(native): meter the microphone for a settings test by @hadrysm in https://github.com/codlume/voice/pull/107
* feat(desktop): add opt-in crash, error, and latency reporting with Sentry by @hadrysm in https://github.com/codlume/voice/pull/111
* feat(desktop): use a switch for crash reports in setup by @hadrysm in https://github.com/codlume/voice/pull/112
* chore(release): leave release PRs out of nightly notes by @hadrysm in https://github.com/codlume/voice/pull/113
* chore(release): list authors in stable release notes by @hadrysm in https://github.com/codlume/voice/pull/114
* feat(desktop): split settings into General and System by @hadrysm in https://github.com/codlume/voice/pull/115
* fix(desktop): keep Voice in Cmd-Tab and the Dock by @hadrysm in https://github.com/codlume/voice/pull/116
* feat(desktop): add a Data and Privacy settings page by @hadrysm in https://github.com/codlume/voice/pull/117
* feat(desktop): add Open at login and Show in Dock settings by @hadrysm in https://github.com/codlume/voice/pull/118
* feat(desktop): add a Show Flow Bar at all times setting by @hadrysm in https://github.com/codlume/voice/pull/120
* feat(desktop): add keyboard shortcuts and a Shortcuts settings page by @hadrysm in https://github.com/codlume/voice/pull/119
* feat(desktop): show release notes when hovering the update button by @hadrysm in https://github.com/codlume/voice/pull/121


**Full Changelog**: https://github.com/codlume/voice/compare/v0.14.0...v0.15.0

## [0.14.0](https://github.com/codlume/voice/compare/v0.13.2...v0.14.0) (2026-09-27)


### Features

* **desktop:** toggle sidebar on empty-space clicks ([#106](https://github.com/codlume/voice/issues/106)) ([2ac8d4e](https://github.com/codlume/voice/commit/2ac8d4ee0d3f156c275e16c2485a2bb7e7b2f2f2))


### Bug Fixes

* **native:** improve RMS performance and quiet audio detection ([#103](https://github.com/codlume/voice/issues/103)) ([79f4128](https://github.com/codlume/voice/commit/79f41286cc4037951d2ec23e28afcc402e2c5244))


### Performance Improvements

* **cleanup:** normalize output once during validation ([#104](https://github.com/codlume/voice/issues/104)) ([d1ecca1](https://github.com/codlume/voice/commit/d1ecca1c83eecb88447f7829c8f1f27b64887c9a))

## [0.13.2](https://github.com/codlume/voice/compare/v0.13.1...v0.13.2) (2026-09-27)


### Bug Fixes

* **desktop:** show sidebar tooltips immediately on hover ([#100](https://github.com/codlume/voice/issues/100)) ([d5a4932](https://github.com/codlume/voice/commit/d5a4932c09d484e59e3f7dfdd95cb06329388667))

## [0.13.1](https://github.com/codlume/voice/compare/v0.13.0...v0.13.1) (2026-09-27)


### Bug Fixes

* **desktop:** preserve capture after microphone setup notifications ([#98](https://github.com/codlume/voice/issues/98)) ([2307603](https://github.com/codlume/voice/commit/230760388f3eb0c716b3446af4ff5fcbfa7d8aaa))

## [0.13.0](https://github.com/codlume/voice/compare/v0.12.0...v0.13.0) (2026-09-27)


### Features

* **desktop:** add microphone selection in settings ([#95](https://github.com/codlume/voice/issues/95)) ([6e89ff8](https://github.com/codlume/voice/commit/6e89ff841fef02edfe4f68c37f9d56d17eddf7a6))
* **desktop:** animate collapsed sidebar tooltips ([#97](https://github.com/codlume/voice/issues/97)) ([731bcda](https://github.com/codlume/voice/commit/731bcda4a6a9a8c42a0b984fb0f4ccd53e14f31b))

## [0.12.0](https://github.com/codlume/voice/compare/v0.11.0...v0.12.0) (2026-09-27)


### Features

* **desktop:** move settings to sidebar footer ([#93](https://github.com/codlume/voice/issues/93)) ([22de22a](https://github.com/codlume/voice/commit/22de22a8552863c9926784ace5b5dbbcb727460b))

## [0.11.0](https://github.com/codlume/voice/compare/v0.10.0...v0.11.0) (2026-09-27)


### Features

* **desktop:** adopt Base UI for settings controls ([#91](https://github.com/codlume/voice/issues/91)) ([8f64214](https://github.com/codlume/voice/commit/8f642149e46adfd432dcfe6ad6dc0c06a55c6cc6))

## [0.10.0](https://github.com/codlume/voice/compare/v0.9.1...v0.10.0) (2026-09-27)


### Features

* **desktop:** move cleanup into a Style sidebar page ([#87](https://github.com/codlume/voice/issues/87)) ([326dfc4](https://github.com/codlume/voice/commit/326dfc4a188696307d9cee727d274d886b9ef9d9))


### Performance Improvements

* **voice-helper:** transcribe long captures before release ([#90](https://github.com/codlume/voice/issues/90)) ([58661a3](https://github.com/codlume/voice/commit/58661a3153c4b4d7a11a33b31405675bf74ac5f2))

## [0.9.1](https://github.com/codlume/voice/compare/v0.9.0...v0.9.1) (2026-09-27)


### Bug Fixes

* **dictation:** apply selected language to speech recognition ([#85](https://github.com/codlume/voice/issues/85)) ([dc6b485](https://github.com/codlume/voice/commit/dc6b48507bc7338f6654b79ceade945b4a8bab39))

## [0.9.0](https://github.com/codlume/voice/compare/v0.8.0...v0.9.0) (2026-09-27)


### Features

* **audio:** mute output while dictating ([#83](https://github.com/codlume/voice/issues/83)) ([b4255e1](https://github.com/codlume/voice/commit/b4255e1d9b4adc07c29c566adb5e2a8d598438bd))

## [0.8.0](https://github.com/codlume/voice/compare/v0.7.0...v0.8.0) (2026-09-27)


### Features

* **settings:** add dictation language preferences ([#81](https://github.com/codlume/voice/issues/81)) ([94a85fc](https://github.com/codlume/voice/commit/94a85fcb3c55da142550173468d1ac62cf398536))

## [0.7.0](https://github.com/codlume/voice/compare/v0.6.0...v0.7.0) (2026-09-27)


### Features

* **desktop:** show update status as an icon in SidebarUpdates ([#79](https://github.com/codlume/voice/issues/79)) ([3a34a22](https://github.com/codlume/voice/commit/3a34a22246bde7fcd2cdcce08fdf48f36aeca785))

## [0.6.0](https://github.com/codlume/voice/compare/v0.5.0...v0.6.0) (2026-09-27)


### Features

* **cleanup:** remove list and email formatting options ([#76](https://github.com/codlume/voice/issues/76)) ([f978607](https://github.com/codlume/voice/commit/f9786079e3061b03f0c54a5e17c5832f9652e8a9))
* **desktop:** collapse the hub sidebar to an icon rail ([#77](https://github.com/codlume/voice/issues/77)) ([1568b5a](https://github.com/codlume/voice/commit/1568b5a68e587c693cd880e2413c895f4461e4ea))

## [0.5.0](https://github.com/codlume/voice/compare/v0.4.0...v0.5.0) (2026-09-26)


### Features

* **web:** add SEO metadata and app favicon ([#73](https://github.com/codlume/voice/issues/73)) ([74fa778](https://github.com/codlume/voice/commit/74fa778f667d23ef1ac7908ab4788e22e692fce5))


### Performance Improvements

* **helper:** keep the microphone engine prepared between sessions ([#75](https://github.com/codlume/voice/issues/75)) ([dae9d11](https://github.com/codlume/voice/commit/dae9d11cd29c4ccc2d6ca43fd11b8a2d9cd5f541))

## [0.4.0](https://github.com/codlume/voice/compare/v0.3.0...v0.4.0) (2026-09-26)


### Features

* **desktop:** ship the new app icon ([#61](https://github.com/codlume/voice/issues/61)) ([799a82c](https://github.com/codlume/voice/commit/799a82c43d696ae2ab7597157a60d8b4807067b0))
* **desktop:** show app icon in sidebar ([#63](https://github.com/codlume/voice/issues/63)) ([#72](https://github.com/codlume/voice/issues/72)) ([61ef47c](https://github.com/codlume/voice/commit/61ef47c76bfb6573380a2605d91bd7be4689bd92))
* **desktop:** style the DMG install window ([#62](https://github.com/codlume/voice/issues/62)) ([#71](https://github.com/codlume/voice/issues/71)) ([14edb53](https://github.com/codlume/voice/commit/14edb535822b1b462e4d36724e7899ac7fabc68d))


### Bug Fixes

* **ci:** allow size labels on pull requests ([#69](https://github.com/codlume/voice/issues/69)) ([02b9c88](https://github.com/codlume/voice/commit/02b9c882647aff15c7b6663b8302f45610073a4c))

## [0.3.0](https://github.com/codlume/voice/compare/v0.2.0...v0.3.0) (2026-09-26)


### Features

* **desktop:** adopt t3code color tokens and add a Theme setting ([#64](https://github.com/codlume/voice/issues/64)) ([10019c1](https://github.com/codlume/voice/commit/10019c12d4efc69abf9c40f427ec6e5cd919ca6b))
* **tray:** replace the microphone menu bar icon with the Voice glyph ([#60](https://github.com/codlume/voice/issues/60)) ([816d4e5](https://github.com/codlume/voice/commit/816d4e5f2dd8edb2d72c39318f9813357c81e098))
* **web:** add Voice download page on Cloudflare Workers ([#66](https://github.com/codlume/voice/issues/66)) ([e89e26c](https://github.com/codlume/voice/commit/e89e26c2e4bc69728de05756991c52f93e8ab088))

## [0.2.0](https://github.com/codlume/voice/compare/v0.1.0...v0.2.0) (2026-09-26)


### Features

* **releases:** attach DMGs to GitHub releases and schedule Nightlies ([#59](https://github.com/codlume/voice/issues/59)) ([c54a4f9](https://github.com/codlume/voice/commit/c54a4f99a42840fa430de4e8b19512ea9be5e532))


### Bug Fixes

* **ci:** exclude generated changelog from formatting ([#57](https://github.com/codlume/voice/issues/57)) ([418dea2](https://github.com/codlume/voice/commit/418dea29c5ab4c653fd7fe9cf6771cf9e03c8acc))

## [0.1.0](https://github.com/codlume/voice/compare/v0.0.1...v0.1.0) (2026-09-26)


### Features

* add explicit practice dictation sessions ([#43](https://github.com/codlume/voice/issues/43)) ([d60a3bd](https://github.com/codlume/voice/commit/d60a3bd0d78a18761f94095cec0d525b217c9bf6))
* add in-app dictation setup and Keychain controls ([#42](https://github.com/codlume/voice/issues/42)) ([ca96153](https://github.com/codlume/voice/commit/ca961531f4e607a16519594fb0879658b2a61f2a))
* add the Voice macOS dictation app with local Parakeet and S1-mini ([#53](https://github.com/codlume/voice/issues/53)) ([d0b894f](https://github.com/codlume/voice/commit/d0b894f7944c844fd271ed0a409af38b54e9100b))
* continue offline captures and retry the complete retained recording ([#47](https://github.com/codlume/voice/issues/47)) ([13341be](https://github.com/codlume/voice/commit/13341be15ce1c3158626f3082bca7a4ea8b24c0e))
* control one session from the floating bar, menu bar, and main window ([#46](https://github.com/codlume/voice/issues/46)) ([bc52bf9](https://github.com/codlume/voice/commit/bc52bf9934b6d98522c4e8837ac416d4dc4e2352))
* dictate from global shortcuts into a native text target ([#45](https://github.com/codlume/voice/issues/45)) ([e1bb35b](https://github.com/codlume/voice/commit/e1bb35b465f42dee80d192d236eb5dc5ca1b9a31))
* insert through clipboard fallback without destroying unrelated content ([#36](https://github.com/codlume/voice/issues/36)) ([#49](https://github.com/codlume/voice/issues/49)) ([29110b5](https://github.com/codlume/voice/commit/29110b5c6f234e45880a211603f60bf56d5179f4))
* launch packaged desktop settings with CI ([#41](https://github.com/codlume/voice/issues/41)) ([1cf7409](https://github.com/codlume/voice/commit/1cf74097d1b4aad01a9092c587f81cd0a6f5a10d))
* prepare reproducible, cost-bounded live acceptance runs ([#38](https://github.com/codlume/voice/issues/38)) ([#51](https://github.com/codlume/voice/issues/51)) ([a15eb67](https://github.com/codlume/voice/commit/a15eb670896df4b50d91d835a1e00a7fd62df10e))
* recover undelivered practice sessions ([#44](https://github.com/codlume/voice/issues/44)) ([b5f277c](https://github.com/codlume/voice/commit/b5f277cbf460191fce24c3d8a889ea7d3ae0bece))
* **releases:** add signed releases and automatic app updates ([#55](https://github.com/codlume/voice/issues/55)) ([3ef2ebe](https://github.com/codlume/voice/commit/3ef2ebe425a8f5b62ca13bd2ca70ea63df7330da))
* stop safely and preserve recovery through access, device, and worker failures ([#35](https://github.com/codlume/voice/issues/35)) ([#48](https://github.com/codlume/voice/issues/48)) ([cc5908c](https://github.com/codlume/voice/commit/cc5908c4bd7dcc8ce0eef85715b62fa38fdda898))
* type safe single-line text into terminals and reach Electron targets ([#37](https://github.com/codlume/voice/issues/37)) ([#50](https://github.com/codlume/voice/issues/50)) ([4891515](https://github.com/codlume/voice/commit/489151592cef065011aa36b7a3304247a854294c))


### Bug Fixes

* keep Retry within the memory budget and measure whole-app resources ([#39](https://github.com/codlume/voice/issues/39)) ([#52](https://github.com/codlume/voice/issues/52)) ([b43fc4d](https://github.com/codlume/voice/commit/b43fc4dcacfae209e16c7470ed818e941d5b3e3c))
