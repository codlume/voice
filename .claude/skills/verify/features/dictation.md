# Dictation

The user holds the hotkey (`fn` by default), speaks, and releases. The Flow Bar shows listening, then processing. Voice transcribes on the Mac, optionally cleans up the text, inserts it into the app that had focus when the key went down, and shows the outcome on the Flow Bar. Escape while holding cancels the session without inserting.

## Sub-features

- `dictate-insert`: speech becomes text in the focused field. Outcome `inserted` with method `accessibility`, or `paste` as the fallback.
- `dictate-cleanup`: with cleanup on, the inserted text is the cleaned version, and the raw transcript is kept in `last.raw`.
- `dictate-raw`: with cleanup off, the inserted text equals the raw transcript.
- `dictate-cancel`: Escape during listening returns to idle and inserts nothing.
- `dictate-too-short`: a press-and-release with almost no audio ends as `tooShort` and inserts nothing.
- `dictate-empty`: silence ends as `empty` and inserts nothing.
- `dictate-not-inserted`: no focused field, a focus change, or secure input ends as `notInserted`, and the transcript is still kept in `last`.
- `flow-bar`: the pill shows the session state. It stays visible at all times when `Show Flow Bar at all times` is on.

## How to get to it (user POV)

- Hold the configured key (`fn`, Right Option, or Right Command) anywhere in macOS. Release to finish, or press Escape to cancel.
- Choose the key under Settings > Shortcuts > `Hold to talk`.

## Driving it with voice-verify

Preconditions: baseline, `vv doctor` shows `otherVoiceProcesses: []` (the user has quit Voice.app and no `pnpm dev` is running), and Accessibility is `granted`.

- **Insert with cleanup.** `vv dictate short.wav`. The output has `outcome.kind` `inserted`, and `inserted` contains "Anna" and "Thursday" and starts with a capital. The timing line has `cleanupMs`.
- **Long dictation with false starts.** `vv dictate long.wav`. The output has `last.raw` containing "um" or "uh", and `last.text` without them.
- **Raw insert.** Turn cleanup off as in [Style](./style.md), then run `vv dictate short.wav`. The output has `inserted === last.raw` and no `cleanupMs`.
- **Cancel.** `vv dictate short.wav --end=escape`. The output has `outcome` `idle` and an empty `inserted`.
- **Too short.** `vv dictate short.wav --end=immediate`. The output has `outcome.kind` `tooShort` and an empty `inserted`.
- **Silence.** `vv dictate silence.wav`. The output has `outcome.kind` `empty` and an empty `inserted`.
- **Flow Bar.** During a session, `vv shot flow-bar pill` captures the pill. `vv eval pill 'document.body.innerText'` reads its text.
- **Proof.** Each `dictate` writes `dictate-<fixture>-<end>-<ts>.json` to the evidence dir with the outcome, the inserted text, `last`, and the timing line.
- **TextEdit target.** `dictate` covers only the Electron textarea. For a native Cocoa target, `stop` the instance and run `pnpm e2e`.

## Gotchas

- `dictate` refuses while any other Voice helper runs, because that app's tap would hear the synthetic key and record the real microphone. Ask the user to quit Voice.app. Never kill it.
- The fixture replaces only the microphone. Microphone selection, device changes, and output muting need a real device and a human.
- `VOICE_HELPER_FORCE_PASTE=1` exercises the paste fallback, but `launch` doesn't set it. The paste fallback writes the real clipboard.
- The first dictation after launch may be slower while the models warm up. Don't treat its timings as representative.
