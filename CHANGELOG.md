# Changelog

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
