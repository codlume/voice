# Settings

Settings holds the controls that aren't about style. General has the microphone and its test, the dictation language, copying the transcript to the clipboard, and the update channel. System has open at login, lowering audio while dictating and by how much, theme, Show in Dock, the always-visible Flow Bar, and page animations under Motion. Shortcuts has the hold-to-talk and toggle dictation keys. Data and Privacy has crash reporting, how long to keep history (see [History](./history.md)), clearing history, and clearing Insights.

## Sub-features

- `settings-microphone`: choose an input device or System default, and run a level test.
- `settings-language`: the spoken language, or Auto-detect. Cleanup is available only for English.
- `settings-copy-to-clipboard`: `Copy transcript to clipboard`.
- `settings-update-channel`: Stable or Nightly.
- `settings-open-at-login`: unavailable in development builds by design.
- `settings-lower-audio`: `Lower audio while dictating`, and `Reduce volume by` from 10% to 100% in 10% steps (default 90%). The amount is disabled while the switch is off and keeps its value. 100% mutes.
- `settings-theme`: System, Light, or Dark.
- `settings-dock`: `Show in Dock`. When it's off, Voice leaves the Dock and Cmd-Tab.
- `settings-flow-bar`: `Show Flow Bar at all times`.
- `settings-page-animations`: `Page animations`, 0 to 400 ms in 25 ms steps.
- `settings-hotkey`: `Hold to talk` is fn, Right Option, or Right Command.
- `settings-toggle-hotkey`: `Toggle dictation` is Off or one of the two keys that are not the hold key. Choosing the toggle key as the hold key turns toggle dictation Off.
- `settings-diagnostics`: `Share crash reports`.
- `settings-reset`: a row whose value differs from its default shows `Reset <row title> to default`. Update channel resets to the installed build's channel.

## How to get to it (user POV)

- Voice window > `Settings` (sidebar footer, or Cmd-,) > `General`, `System`, `Shortcuts`, or `Data and Privacy`. `Back` (Cmd-[) returns to the Voice nav.

## Driving it with voice-verify

Preconditions: baseline.

- **Open a page.** `vv click Settings`, then `vv click System`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "System"'`.
- **Toggle a switch.** `vv click "Show in Dock"`, then `vv wait hub 'window.voice.getSnapshot().then(s => s.settings.showInDock === false)'`. `settings.json` shows `"showInDock": false`. Click it again to restore.
- **Pick from a select.** `vv click css:#setting-hotkey`, then `vv click "Right Option"`, then wait for `s.settings.hotkey === "rightOption"`. Then `vv click Back` and `vv click Home`, and `vv text` reads "Hold ⌥ Right Option, speak, and let go." Restore `fn` with `vv click "Reset Hold to talk to default"`.
- **Language disables cleanup.** Pick a non-English option in `css:#setting-dictation-language`. Then `vv click Back` and `vv click Style`. The `Clean up text` switch is disabled.
- **Set the Reduce volume by slider.** `vv click "Lower audio while dictating"` and wait for `s.settings.lowerAudioWhileDictating === true`, because the slider is disabled while the switch is off. Focus it with `vv eval hub 'document.querySelector("input[type=range][aria-label=\"Reduce volume by\"]").focus()'`, press `vv key ArrowLeft` four times, then wait for `s.settings.lowerAudioByPercent === 50`. The readout shows `50%`. Turning the switch off keeps 50. With the switch on, `vv click "Reset Reduce volume by to default"` restores 90.
- **Set the Page animations slider.** Send the key from the page with `vv eval hub 'document.querySelector("input[type=range][aria-label=\"Page animation duration\"]").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))'`, then wait for `s.settings.pageAnimationMs === 400`. `vv click "Reset Page animations to default"` restores 200.
- **Reset.** After changing `Show in Dock`, Theme (`vv click Dark`), or Update channel (`vv click css:#setting-update-channel`, `vv click Nightly`), `vv click "Reset Show in Dock to default"`, `"Reset Theme to default"`, or `"Reset Update channel to default"` restores the default, and the button disappears.
- **Open at login.** On System, `#setting-open-at-login` is disabled, and the snapshot's `loginItem` is `unavailable`. That is correct for a development build.

## Gotchas

- If a select option isn't found, run `vv eval hub` on `[...document.querySelectorAll("[role=option]")].map(o => o.textContent)` to see what the popup renders.
- On the System page the nav item and the Theme radio are both named `System`, so `vv click System` fails there. Leave the page first, or reset the theme with its reset button.
- The microphone test reads the fixture file, which exists only during `dictate`. In the verify instance the test fails by design. Testing a real microphone needs a human.
- Turning `Share crash reports` on takes effect only at the next launch.
- Lowering audio changes the Mac's real output devices, even in test mode. `node native/voice-helper/scripts/output-mute-smoke.mjs` proves lowering, muting, and restoring on the real default output without the app, and puts the original volume back when it ends.
- Hotkey and dictation-language changes affect the next `dictate`. Restore the defaults before running a dictation recipe.
