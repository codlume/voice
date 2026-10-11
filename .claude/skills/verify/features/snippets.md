# Snippets

Snippets let a user save a spoken trigger, such as "my email", and the exact text Voice types in its place. Saying only the trigger types only the saved text. Saying it inside a sentence replaces just the trigger. Cleanup never rewrites the saved text. With no snippets saved, the page shows one example row.

## Sub-features

- `snippets-add`: `Add new` opens the `Add snippet` dialog with `Trigger` and `Expansion` fields and an n/max counter on each. Enter in `Trigger` saves.
- `snippets-validate`: saving an empty, too long, or duplicate trigger, or an empty expansion, keeps the dialog open and shows the problem under the field. Duplicates ignore case, spaces, and punctuation.
- `snippets-edit`: the pencil button on a row opens `Edit snippet`, and `Save changes` replaces that snippet in place.
- `snippets-delete`: the trash button asks "Delete snippet?" with "‘<trigger>’ will be deleted permanently." (curly quotes) before it deletes.
- `snippets-save-failed`: a rejected save keeps the dialog open with the draft and shows "Could not save this snippet. Try again."
- `snippets-dictation`: a dictation that contains a trigger inserts the expansion.

## How to get to it (user POV)

- Voice window sidebar: `Snippets`, after Style.
- Keyboard: Cmd-3 in the Voice nav.

## Driving it with voice-verify

Preconditions: baseline. No snippets are saved.

- **Open Snippets.** `vv click Snippets`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Snippets"'`. Then `vv shot snippets-empty`. The card shows the `my email` example.
- **Add.** `vv click "Add new"`, then `vv type 'css:[role="dialog"] input' Thursday`, then `vv type 'css:[role="dialog"] textarea' "next Friday"`. `vv click "Add snippet"`, then `vv wait hub 'window.voice.getSnapshot().then(s => s.settings.snippets.some(x => x.trigger === "Thursday"))'`. Then `vv shot snippets-added`.
- **Stored value.** `cat "<userData>/settings.json"` lists the snippet under `"snippets"` with a generated `id`. The file does not exist until the first setting is saved.
- **Duplicate.** `vv click "Add new"`, then type `thursday.` into the trigger and anything into the expansion, then `vv click "Add snippet"`. The dialog stays open and reads "This trigger is already used by another snippet." The stored list does not change. Click `Cancel`.
- **Effect on dictation.** When `dictate` is available, run `vv dictate short.wav`. `inserted` contains "next Friday" in place of "Thursday", and still contains "Anna".
- **Edit.** `vv click "Edit Thursday"`. `type` inserts at the caret like a paste, so select the old text first with `vv eval hub 'document.querySelector("[role=dialog] textarea").select(), true'`, then `vv type 'css:[role="dialog"] textarea' "<new expansion>"`. `vv click "Save changes"`, then wait for the new expansion in `s.settings.snippets`. The `id` stays the same.
- **Delete.** `vv click "Delete Thursday"`, then `vv click Delete`, then wait for `s.settings.snippets.length === 0`. The page shows the example row again.

## Gotchas

- The row buttons are named `Edit <trigger>` and `Delete <trigger>`. The dialog's confirm button is `Add snippet` or `Save changes`, not `Add new`.
- Problems show only after a save attempt, then update as you type. An empty dialog with no error is expected.
- Clicking outside the dialog does not close it. Escape and `Cancel` do, and both discard the draft.
- The renderer preview harness has a `snippets` scene (`preview.html?hub=snippets`) with three saved snippets. It runs on a fake `window.voice`, so it proves layout and dialog flow, not storage or dictation.
