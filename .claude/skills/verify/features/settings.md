# Settings

Settings holds the controls that aren't about style. General has the microphone and its test, the dictation language, copying the transcript to the clipboard, and the update channel. System has open at login, muting while dictating, theme, Show in Dock, and the always-visible Flow Bar. Shortcuts has the hold-to-talk key. Data and Privacy has crash reporting.

## Sub-features

- `settings-microphone`: choose an input device or System default, and run a level test.
- `settings-language`: the spoken language, or Auto-detect. Cleanup is available only for English.
- `settings-copy-to-clipboard`: `Copy transcript to clipboard`.
- `settings-update-channel`: Stable or Nightly.
- `settings-open-at-login`: unavailable in development builds by design.
- `settings-mute`: `Mute all audio while dictating`.
- `settings-theme`: System, Light, or Dark.
- `settings-dock`: `Show in Dock`. When it's off, Voice leaves the Dock and Cmd-Tab.
- `settings-flow-bar`: `Show Flow Bar at all times`.
- `settings-hotkey`: `Hold to talk` is fn, Right Option, or Right Command.
- `settings-diagnostics`: `Share crash reports`.

## How to get to it (user POV)

- Voice window > `Settings` (sidebar footer, or Cmd-,) > `General`, `System`, `Shortcuts`, or `Data and Privacy`. `Back` (Cmd-[) returns to the Voice nav.

## Driving it with voice-verify

Preconditions: baseline.

- **Open a page.** `vv click Settings`, then `vv click System`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "System"'`.
- **Toggle a switch.** `vv click "Show in Dock"`, then `vv wait hub 'window.voice.getSnapshot().then(s => s.settings.showInDock === false)'`. `settings.json` shows `"showInDock": false`. Click it again to restore.
- **Pick from a select.** `vv click css:#setting-hotkey`, then `vv click "Right Option"`, then wait for `s.settings.hotkey === "rightOption"`. Then `vv click Back` and `vv click Home`, and `vv text` reads "Hold Right Option and speak". Restore `fn` the same way.
- **Language disables cleanup.** Pick a non-English option in `css:#setting-dictation-language`. Then `vv click Back` and `vv click Style`. The `Clean up text` switch is disabled.
- **Open at login.** On System, `#setting-open-at-login` is disabled, and the snapshot's `loginItem` is `unavailable`. That is correct for a development build.

## Gotchas

- The select recipe (click the trigger, then click the option by name) hasn't been run yet. If the option isn't found, run `vv eval hub` on `[...document.querySelectorAll("[role=option]")].map(o => o.textContent)` to see what the popup actually renders.
- The microphone test reads the fixture file, which exists only during `dictate`. In the verify instance the test fails by design. Testing a real microphone needs a human.
- Turning `Share crash reports` on takes effect only at the next launch.
- Hotkey and dictation-language changes affect the next `dictate`. Restore the defaults before running a dictation recipe.
