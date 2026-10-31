# Transforms

The user selects text in any app and presses a transform shortcut. Voice reads the selection, rewrites it on the Mac with the transform model, and replaces the selection with the result. The built-ins are Polish on Option+1 and Prompt Engineer on Option+2. The Flow Bar shows the run and then its outcome. Escape during a run cancels it and leaves the text unchanged. Transforms are off by default. The Transforms page turns them on, edits the list, picks an optional transform to run after every dictation, and shows the last run with its original and result.

## Sub-features

- `transforms-toggle`: the `Transforms` switch on the Transforms page. Turning it on with the model missing asks to download it first (`Download and turn on`). `s.settings.transforms.enabled` holds the state.
- `transforms-run`: Left Option plus the shortcut key with text selected replaces the selection with the result. The Flow Bar shows `transforming`, then `transformDone` with outcome `inserted` for about 1.3 s. Apps with accessibility support are read and written through it (`via=accessibility`). Others are read with a copy and written with a paste (`via=copy`), and the clipboard is restored.
- `transforms-loading`: the first run after launch, or after 30 idle minutes, loads the model. The load starts when the shortcut fires, while the selection is read. The Flow Bar reads "Loading model" and the run then continues.
- `transforms-cancel`: Escape during a run ends it as `cancelled`. The Flow Bar reads "Cancelled. Text unchanged".
- `transforms-refusals`: each refusal leaves the text alone and shows its own Flow Bar message for about 2.5 s. Nothing selected gives "Select text first". A secure field gives "Can't read a secure field". Too many words gives "Too long. Select up to N words". A missing model gives "Set up the transform model in Voice". A write refused after the read, for example because the text changed, gives a "… Result is in Voice" message, and the result stays in the Last transform panel.
- `transforms-disarm`: while the Voice window has focus, no transform shortcut is registered. Option+1 then types in Voice's own fields, and the shortcut picker can record it.
- `transforms-edit`: `Create`, `Edit <name>`, and `Restore defaults` manage the list. The editor has `Name`, `Instruction`, and a `Shortcut` picker that records the next key press.
- `transforms-after-dictation`: the `After dictation` select runs one transform on every dictation in place of cleanup. It is disabled while Transforms are off.
- `transforms-last`: the Last transform panel shows `Before` and `After <name>` for the most recent run, with `Copy original` and `Copy result`. It lives in memory until Voice quits and clears when Transforms are turned off.
- `transforms-log`: main.log gets one line per run, `transform <id8> outcome=<kind> via=<accessibility|copy> readMs=… generateMs=… insertMs=… words=<n>`. It never holds the text.

## How to get to it (user POV)

- The Voice nav item `Transforms`, between Style and Snippets, or Cmd+5 in the Voice window.
- In any other app, select text and press Option+1 or Option+2, or the shortcut set in the editor.
- Settings > Models lists the transform model with the speech and cleanup models.

## Driving it with voice-verify

Preconditions: baseline, `vv doctor` shows `optionalTestModels.transform: "cached"` and `otherVoiceProcesses: []`, and Accessibility is `granted`. `launch` links the cached model, so `s.models.transform.state` starts `installed`. If `doctor` shows `missing`, seed the shared cache once from the repo root before `launch`. It downloads the 3.1 GB `gemma-4-E2B-it-Q4_K_M.gguf` into `~/Library/Caches/Voice Development/test-models`, checks its SHA-256, and returns at once when the file is already there:

```sh
node --input-type=module -e 'import { downloadModel } from "./packages/cleanup/src/download.ts"; import { GEMMA_4_E2B } from "./packages/cleanup/src/transform/model.ts"; import { modelsDir } from "./native/voice-helper/scripts/helper.mjs"; await downloadModel({ dir: modelsDir(), source: GEMMA_4_E2B });'
```

- **Turn on.** `vv key Digit4 command`, then `vv click 'css:main [role="switch"]'`. Wait for `s.settings.transforms.enabled === true`. With the model linked, no download dialog opens.
- **Run in the scratch textarea.** `vv transform`. It selects a synthetic 40-word paragraph, posts Left Option+1, and follows the Flow Bar. Expect `outcome.kind` `inserted` with method `paste`, `after` different from `before` and equal to `lastTransform.after`, `clipboardUnchanged: true`, and a `logLine` with `via=copy`. `clipboardUnchanged` compares every type on the clipboard, so an image or rich text counts. When it is `false`, the command has put the saved clipboard back and says so on stderr.
- **Run in TextEdit.** `vv transform --target=textedit`. Expect `outcome.kind` `inserted` with method `accessibility` and `via=accessibility` in `logLine`. The command opens and closes its own named document.
- **Prompt Engineer.** `vv transform --shortcut=19`. The output names `transform` `Prompt Engineer`.
- **Cancel.** `vv transform --escape`. It posts Escape 400 ms into the run. Expect `outcome.kind` `cancelled`, `after === before`, and `escapedAfterMs` set.
- **Loading.** The first run after `launch` reports `pill.sawLoading: true`. Later runs within 30 minutes do not.
- **Flow Bar.** `transform` blocks, so run it in the background. During a load, `vv eval pill 'document.body.innerText'` reads "Loading model". During generation, the `[role=status]` element's `data-view` is `processing`. Then `vv shot transform-done pill` captures the outcome.
- **Record a shortcut.** `vv click "Edit Polish"`, `vv click Shortcut` (which focuses the picker, so it records the next press), `vv key Digit3 option`, then `vv click "Save changes"`. Polish's `shortcut` is `{ keycode: 20, modifiers: ["option"] }`, and `vv transform --shortcut=20` runs it.
- **Last transform.** After a run, `vv front`, then `vv text` shows `Before` and `After Polish` with the paragraph and result, and `vv eval hub 'window.voice.getLastTransform()'` returns the run's `lastTransform`. To check `Copy result`, run `vv clipboard save`, then `vv click "Copy result"`, check that `pbpaste` prints `lastTransform.after`, and run `vv clipboard restore`.
- **No text in the log.** After a run, `grep -c "garden club" <userData>/main.log` prints 0.
- **Proof.** Each run writes `transform-<electron|textedit>[-escape]-<ts>.json` to the evidence dir with the outcome, the target text before and after, the Last transform, `clipboardUnchanged`, and the log line. The clipboard's contents are never written.

## Gotchas

- `transform` refuses while any other Voice helper runs, like `dictate`, because that helper's tap would hear the shortcut and the Escape.
- `transform` fails early when Transforms are off or no transform sits on exactly Option plus that key. A shortcut with other modifiers cannot be posted by it.
- The target must be frontmost when the shortcut is posted, and the Voice window must not have focus. `transform` arranges both. It leaves the Voice window covered, so run `front` before driving the page.
- The switch and the nav item are both named `Transforms`. On the Transforms page, click the switch by `css:main [role="switch"]`.
- Without the cached model, turning Transforms on downloads the 3.1 GB model into the scratch userData, and `stop` deletes it. Seed the cache with the command under Preconditions, then `stop` and `launch` so the instance links it.
- `transform` always selects the whole paragraph, so it cannot produce `noSelection`, `secureInput`, or `selectionChanged`. `node native/voice-helper/scripts/selection-smoke.mjs electron` and `… textedit` cover the helper's read, the write guard, and the clipboard restore without the app.
- `Copy original` and `Copy result` overwrite the real clipboard. Run `vv clipboard save` before and `vv clipboard restore` after.
- The last real-app run was at commit adad582a, before later changes to the helper reader and the model lifecycle, and has not been rerun since. Rerun the recipes above after touching either. At that commit the Electron textarea (copy path) took the paste and TextEdit (accessibility path) took the insert, both with the clipboard unchanged as `pbpaste` saw it. Escape mid-run cancelled with the text unchanged. A Safari read-only page was refused (`focusChanged`) with the result copyable from Last transform. A real Chrome textarea (isolated profile) took the insert by copy. In TextEdit, 40 words took 1.3 to 1.9 s warm and 154 words took 3.7 to 3.9 s warm. The cold first run took about 5 s, occasionally 28 s under memory pressure.
