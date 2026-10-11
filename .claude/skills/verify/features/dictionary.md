# Dictionary

The Dictionary lets a user save words and replacements. A word, such as "Wispr Flow" or "Hadryś", fixes how Voice writes it: "wispr flow" becomes "Wispr Flow" and "Hadrys" becomes "Hadryś", because matching ignores case and accents. A replacement, such as "btw → by the way", types the saved text in place of the phrase. Dictionary entries and snippets are applied together in one pass over the transcript, longest phrase first, so neither rewrites the other's saved text. A phrase matches only between word breaks or punctuation on both sides: "U.S." leaves "U.S.A." alone. The last transcript's raw text stays what the speech model heard. With no entries saved, the page shows one example row.

## Sub-features

- `dictionary-add`: `Add new` opens the `Add to dictionary` dialog with a `Phrase` field and an optional `Replace with` field, each with an n/max counter (100 and 500). An empty `Replace with` saves a word. Enter in either field saves.
- `dictionary-validate`: saving an empty, too long, or duplicate phrase keeps the dialog open and shows the problem under the field. Duplicates ignore case, accents, and spacing; phrases that differ in punctuation, such as `e-mail` and `email`, are separate entries. A phrase that is a snippet trigger, up to case, accents, and spacing, shows "This phrase is already a snippet trigger."
- `dictionary-snippet-guard`: on the Snippets page, a trigger that is already a dictionary phrase shows "This trigger is already in your dictionary."
- `dictionary-edit`: the pencil button on a row opens `Edit dictionary entry`, and `Save changes` replaces that entry in place.
- `dictionary-delete`: the trash button asks "Delete from dictionary?" with "‘<phrase>’ will be deleted permanently." (curly quotes) before it deletes.
- `dictionary-save-failed`: a rejected save keeps the dialog open with the draft and shows "Could not save this entry. Try again."
- `dictionary-dictation`: a dictation that contains a saved phrase inserts the saved spelling or replacement.

## How to get to it (user POV)

- Voice window sidebar: `Dictionary`, after Snippets.
- Keyboard: Cmd-4 in the Voice nav.

## Driving it with voice-verify

Preconditions: baseline. No dictionary entries or snippets are saved. The phrase input has the placeholder `Wispr Flow` and the replacement input `Optional`, which tell the two inputs apart.

- **Open Dictionary.** `vv click Dictionary`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Dictionary"'`. Then `vv shot dictionary-empty`. The card shows the `Wispr Flow` example.
- **Add a word.** `vv click "Add new"`, then `vv type 'css:[role="dialog"] input[placeholder="Wispr Flow"]' "Wispr Flow"`. `vv click "Add to dictionary"`, then wait for `s.settings.dictionary.some(x => x.phrase === "Wispr Flow" && x.replacement === null)`.
- **Add a replacement.** `vv click "Add new"`, type `btw` into the phrase and `by the way` into `css:[role="dialog"] input[placeholder="Optional"]`, then `vv click "Add to dictionary"`. The row reads `btw → by the way`. Then `vv shot dictionary-filled`.
- **Stored value.** `cat "<userData>/settings.json"` lists both entries under `"dictionary"` with generated `id`s, the word with `"replacement": null`.
- **Duplicate.** Add `WISPR  flow`. The dialog stays open and reads "This phrase is already in your dictionary." The stored list does not change. Click `Cancel`.
- **Snippet collision.** Save a `my email` snippet on the Snippets page, then add `My Email` here. The dialog reads "This phrase is already a snippet trigger." On the Snippets page, adding the trigger `BTW` reads "This trigger is already in your dictionary."
- **Effect on dictation.** When `dictate` is available, save the word `THURSDAY` and run `vv dictate short.wav`. `inserted` contains "THURSDAY" and `last.raw` still contains "Thursday".
- **Edit.** `vv click "Edit btw"`. Select the old replacement first with `vv eval hub 'document.querySelector("[role=dialog] input[placeholder=Optional]").select(), true'`, then type the new one. `vv click "Save changes"`, then wait for it in `s.settings.dictionary`. The `id` stays the same.
- **Delete.** `vv click "Delete btw"`, wait for the confirm text in `[role=alertdialog]`, then `vv click Delete` and wait for the entry to leave `s.settings.dictionary`. With no entries left, the page shows the example row again.

## Gotchas

- The row buttons are named `Edit <phrase>` and `Delete <phrase>`. The dialog's confirm button is `Add to dictionary` or `Save changes`, not `Add new`.
- The editor is `[role=dialog]`, but the delete confirmation is `[role=alertdialog]`.
- Problems show only after a save attempt, then update as you type.
- A phrase in a script written without spaces, such as Chinese or Japanese, matches only when the dictation separates it with spaces or punctuation; `東京` inside `東京都` is left alone.
- A settings file edited by hand can hold a dictionary phrase and a snippet trigger that are the same phrase. The snippet wins during dictation, and the pair never blocks saving anything else.
- While the Voice window sits behind other windows, it reports `document.visibilityState === "hidden"`, so a closed dialog can stay in the DOM with `data-closed` for up to a minute. Wait on `s.settings` for a save, not on the dialog leaving the DOM. Snippets behaves the same.
- The renderer preview harness has a `dictionary` scene (`preview.html?hub=dictionary`) with four entries and one snippet. It runs on a fake `window.voice`, so it proves layout and dialog flow, not storage or dictation.
