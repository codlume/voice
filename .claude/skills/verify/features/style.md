# Style

Style lets a user turn text cleanup on or off and choose how cleaned-up dictation reads: Casual, Semi-casual, Semi-formal, or Formal. With cleanup off, the style cards are disabled, and dictation is inserted exactly as recognized.

## Sub-features

- `style-cleanup-toggle`: the `Clean up text` switch turns cleanup on and off. Turning it off unloads the cleanup model, which then reports `installed`. Turning it on loads the model again.
- `style-pick`: choosing a card sets the writing style used for the next dictation.
- `style-disabled`: with cleanup off, the cards are disabled and the page explains that the transcript is inserted as recognized.

## How to get to it (user POV)

- Voice window sidebar: `Style`.
- Keyboard: Cmd-2 in the Voice nav jumps to the second sidebar item.

## Driving it with voice-verify

Preconditions: baseline. Cleanup is on and styling is `semi-formal`.

- **Open Style.** `vv click Style`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Style"'`. Then `vv shot style-before`.
- **Pick a style.** `vv click Formal`, then `vv wait hub 'window.voice.getSnapshot().then(s => s.settings.cleanup.styling === "formal")'`. The Formal card shows the check mark.
- **Turn cleanup off.** `vv click "Clean up text"`, then `vv wait hub 'window.voice.getSnapshot().then(s => !s.settings.cleanup.enabled && s.models.cleanup.state === "installed")' 15000`, then `vv wait hub 'document.querySelector("fieldset").disabled'`. Then `vv shot style-cleanup-off`. The page reads "Turn on cleanup to apply a style. Your transcript is currently inserted as recognized."
- **Stored value.** `cat "$TMPDIR/voice-verify/settings.json"` shows `"cleanup": { "enabled": false, "styling": "formal" }`.
- **Turn cleanup on.** `vv click "Clean up text"`, then wait for `s.models.cleanup.state === "ready"` with a 60000 ms timeout.
- **Effect on dictation.** When `dictate` is available, run `vv dictate short.wav` once with cleanup off. Check that `last.raw === last.text`, that `inserted` equals the raw text, and that the timing line has no `cleanupMs`.

## Gotchas

- The switch's accessible name comes from its `<label>`, `Clean up text`. The cards are named by their titles.
- Cleanup supports English only. With another dictation language, the switch is disabled. Check `settings.dictationLanguage` before treating a disabled switch as a bug.
- Reloading the model after you turn cleanup back on takes seconds. Wait on the model state, not a timer.
