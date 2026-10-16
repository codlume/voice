# Dictation

The user holds the hotkey (`fn` by default), speaks, and releases. With a toggle key set, the user can instead tap it once to start and again to stop. The Flow Bar shows listening, then processing. Voice transcribes on the Mac, optionally cleans up the text, inserts it into the app that had focus when the key went down, and shows the outcome on the Flow Bar. Escape while holding cancels the session without inserting.

## Sub-features

- `dictate-insert`: speech becomes text in the focused field. Outcome `inserted` with method `accessibility`, or `paste` as the fallback.
- `dictate-cleanup`: with cleanup on, the inserted text is the cleaned version, and the raw transcript is kept in `latest.raw`.
- `dictate-raw`: with cleanup off, the inserted text equals the raw transcript.
- `dictate-toggle`: a tap of the toggle key (press and release with no other key between) starts listening, and the next tap stops and inserts. The toggle key used in a shortcut, such as Right Option + a, does nothing.
- `dictate-cancel`: Escape during listening returns to idle and inserts nothing.
- `dictate-too-short`: a press-and-release with almost no audio ends as `tooShort` and inserts nothing.
- `dictate-empty`: silence ends as `empty` and inserts nothing.
- `dictate-not-inserted`: no focused field, a focus change, or secure input ends as `notInserted`, and the transcript is still kept in the history, where `latest.status` is `notInserted`.
- `flow-bar`: the pill shows the session state. It stays visible at all times when `Show Flow Bar at all times` is on.

## How to get to it (user POV)

- Hold the configured key (`fn`, Right Option, or Right Command) anywhere in macOS. Release to finish, or press Escape to cancel.
- Choose the key under Settings > Shortcuts > `Hold to talk`.
- Optionally choose a second key under Settings > Shortcuts > `Toggle dictation` (Off by default). Tap it once to start and again to stop.

## Driving it with voice-verify

Preconditions: baseline, `vv doctor` shows `otherVoiceProcesses: []` (the user has quit Voice.app and no `pnpm dev` is running), and Accessibility is `granted`.

- **Insert with cleanup.** `vv dictate short.wav`. The output has `outcome.kind` `inserted`, and `inserted` contains "Anna" and "Thursday" and starts with a capital. The timing line has `cleanupMs`.
- **Long dictation with false starts.** `vv dictate long.wav`. The output has `latest.raw` containing "um" or "uh", and `latest.text` without them.
- **Raw insert.** Turn cleanup off as in [Style](./style.md), then run `vv dictate short.wav`. The output has `inserted === latest.raw` and no `cleanupMs`.
- **Toggle.** Choose a key under `Toggle dictation` (`click css:#setting-toggle-hotkey`, then `click "Right Option"`), then `vv dictate short.wav --key=toggle`. The output has `mode` `toggle` and `outcome.kind` `inserted`.
- **Cancel.** `vv dictate short.wav --end=escape`. The output has `outcome` `idle` and an empty `inserted`.
- **Too short.** `vv dictate short.wav --end=immediate`. The output has `outcome.kind` `tooShort` and an empty `inserted`.
- **Silence.** `vv dictate silence.wav`. The output has `outcome.kind` `empty` and an empty `inserted`.
- **Flow Bar.** During a session, `vv shot flow-bar pill` captures the pill. `vv eval pill 'document.body.innerText'` reads its text.
- **Proof.** Each `dictate` writes `dictate-<fixture>-<end>-<ts>.json` to the evidence dir with the outcome, the inserted text, `latest` (the history entry this session added, or `null`), and the timing line.
- **Target app.** `vv dictate short.wav --app=com.apple.MobileSMS` and `vv dictate short.wav --app=com.google.Chrome@mail.google.com` both end with `outcome.kind` `inserted`, and the output records `app` with the bundle id and host you passed. The helper reports that target instead of the scratch window for this one session, and main uses it to pick the category style and to count the session's app in [Insights](./insights.md). [Style](./style.md) has the recipe that proves each target gets its category's style.
- **TextEdit target.** `dictate` covers only the Electron textarea. For a native Cocoa target, `stop` the instance and run `pnpm e2e`.

## Gotchas

- `dictate` refuses while any other Voice helper runs, because that app's tap would hear the synthetic key and record the real microphone. Ask the user to quit Voice.app. Never kill it.
- The fixture replaces only the microphone. Microphone selection, device changes, and output muting need a real device and a human.
- `VOICE_HELPER_FORCE_PASTE=1` exercises the paste fallback, but `launch` doesn't set it. The paste fallback writes the real clipboard. `node native/voice-helper/scripts/insert-smoke.mjs paste` checks that it inserts and restores the clipboard, and `node native/voice-helper/scripts/focus-smoke.mjs paste` checks that a window switch refuses it.
- `dictate` fails with "capture ended … before <fixture> finished" when the session stops before the whole fixture has streamed, and the JSON records `captureEndedEarly`. Such a run proves nothing about the fixture. Scripted hotkey presses can lose the key's flag state and end the session this way, so rerun it.
- The first dictation after launch may be slower while the models warm up. Don't treat its timings as representative.
