# Snippets

Snippets let a user save a spoken trigger, such as "my email", and the exact text Voice types in its place. Saying only the trigger types only the saved text. Saying it inside a sentence replaces just the trigger. A trigger matches whatever its case or accents in speech, and only between word breaks or punctuation on both sides. Snippets and dictionary entries are applied together in one pass, longest phrase first, so a dictionary entry never rewrites a trigger or an expansion. Cleanup never rewrites the saved text. With no snippets saved, the page shows one example row.

## Sub-features

- `snippets-add`: `Add new` opens the `Add snippet` dialog with `Trigger` and `Expansion` fields, an n/max counter on each, and an `Enabled` switch that starts on, at the left of the Cancel and Save buttons. Enter in `Trigger` and Cmd+Enter in `Expansion` save.
- `snippets-format`: `Expansion` is a rich text editor with `Bold`, `Italic`, `Bulleted list`, `Numbered list`, and `Link` toolbar buttons, which show as pressed for the selection. Cmd+B, Cmd+I, and Markdown typed as `- `, `1. `, `**bold**`, `*italic*`, and `[text](url)` format too. `Link` or Cmd+K opens a `Link address` row with `Apply`, and `Remove` on an existing link. Escape closes only that row. A formatted snippet stores `expansionHtml` (only p, ul, ol, li, strong, em, a, br) next to the plain `expansion`, which marks list items `- ` and `1. ` and writes a link as `text (url)`, or only the URL when the text is the URL. `Apply` with no text selected inserts the URL as its own link text. Unformatted text stores `expansionHtml: null`. The counter counts `expansion`.
- `snippets-validate`: saving an empty trigger ("Enter a trigger phrase."), a trigger with no letter or digit ("Use at least one letter or number."), a duplicate trigger, or an empty expansion ("Enter the text Voice should type.") keeps the dialog open and shows the problem under the field. `Trigger` stops typing at 60 characters; `Expansion` reports more than 4,000. Duplicates ignore case, accents, and spacing; triggers that differ in punctuation, such as `e-mail` and `email`, are separate snippets. A trigger that is already a dictionary phrase, up to case, accents, and spacing, shows "This trigger is already in your dictionary."
- `snippets-edit`: the pencil button on a row opens `Edit snippet`, and `Save changes` replaces that snippet in place.
- `snippets-delete`: the trash button asks "Delete snippet?" with "‘<trigger>’ will be deleted permanently." (curly quotes) before it deletes.
- `snippets-toggle`: the `Enabled` switch in the add and edit dialog turns the snippet off or on when the dialog saves. Cancel discards the change. A switched-off snippet stays saved and editable, its row text is faded with an `Off` label, and dictation never expands it. Its trigger still counts as taken.
- `snippets-save-failed`: a rejected save keeps the dialog open with the draft and shows "Could not save this snippet. Try again."
- `snippets-dictation`: a dictation that contains an enabled trigger inserts the expansion. A plain-text target such as the scratch textarea gets the plain `expansion`.

## How to get to it (user POV)

- Voice window sidebar: `Snippets`, after Style.
- Keyboard: Cmd-6 in the Voice nav.

## Driving it with voice-verify

`vv scenario snippet-expansion` asserts the expansion in a dictation, not the add dialog; see [Asserted scenarios](../SKILL.md#asserted-scenarios).

Preconditions: baseline. No snippets are saved.

- **Open Snippets.** `vv click Snippets`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Snippets"'`. Then `vv shot snippets-empty`. The card shows the `my email` example.
- **Add.** `vv click "Add new"`, then `vv type 'css:[role="dialog"][data-open] input[placeholder="my email"]' Thursday`, then `vv type 'css:[role="dialog"][data-open] [contenteditable]' "next Friday"`. The placeholder is required: the `Enabled` switch has an input too. `vv click "Add snippet"`, then `vv wait hub 'window.voice.getSnapshot().then(s => s.settings.snippets.some(x => x.trigger === "Thursday"))'`. Then `vv shot snippets-added`.
- **Format.** In the dialog, `vv click Bold`, type, `vv click Bold` again, and `vv click "Bulleted list"`. To link a word, select it with `getSelection().setBaseAndExtent(...)` on its text node in an `eval` (without a selection the URL becomes the link text), then `vv click Link`, `vv type 'css:[aria-label="Link address"]' example.com`, and `vv click Apply`. After saving, `s.settings.snippets` holds `expansionHtml` such as `<p>Hi <strong>Ada</strong></p><ul><li>one</li></ul>`. Reopen with `Edit <trigger>` and the formatting is back. Markdown shortcuts fire only on a one-character insertion, so `type` the trigger character on its own: `vv type '…' "1."`, then `vv type '…' " "`. Press Enter, Cmd+K, or Escape with `eval` dispatching a `keydown` on `document.activeElement`. Lexical and the dialog handle that the same as a real key.
- **Stored value.** `cat "<userData>/settings.json"` lists the snippet under `"snippets"` with a generated `id`. The file does not exist until the first setting is saved.
- **Duplicate.** `vv click "Add new"`, then type `THURSDAY` into the trigger and anything into the expansion, then `vv click "Add snippet"`. The dialog stays open and reads "This trigger is already used by another snippet." The stored list does not change. Click `Cancel`.
- **Effect on dictation.** When `dictate` is available, run `vv dictate short.wav`. `inserted` contains "next Friday" in place of "Thursday", and still contains "Anna". With the snippet switched off, `inserted` keeps "Thursday".
- **Edit.** `vv click "Edit Thursday"`. `type` inserts at the caret like a paste, so select the old text first with `vv eval hub 'getSelection().selectAllChildren(document.querySelector("[role=dialog][data-open] [contenteditable]")), true'`, then `vv type 'css:[role="dialog"][data-open] [contenteditable]' "<new expansion>"`. Replacing everything keeps the first block's type, so a snippet that starts with a list stays a list. `vv click "Save changes"`, then wait for the new expansion in `s.settings.snippets`. The `id` stays the same.
- **Toggle.** `vv click "Edit Thursday"`, then `vv click Enabled`, then `vv click "Save changes"`, then `vv wait hub 'window.voice.getSnapshot().then(s => s.settings.snippets[0].enabled === false)'`. The row text fades and the row shows `Off`. Repeat to switch it back on.
- **Delete.** `vv click "Delete Thursday"`, then `vv click Delete`, then wait for `s.settings.snippets.length === 0`. The page shows the example row again.

## Gotchas

- The row controls are named `Edit <trigger>` and `Delete <trigger>`. The dialog's confirm button is `Add snippet` or `Save changes`, not `Add new`.
- Problems show only after a save attempt, then update as you type. An empty dialog with no error is expected.
- The verify window usually reports `document.hidden`, so a closed dialog can stay mounted at opacity 0 with `data-ending-style` and keep matching `[role=dialog]`. Scope selectors to `[role=dialog][data-open]`, or run `vv front`.
- Clicking outside the dialog does not close it. Escape and `Cancel` do, and both discard the draft.
- The renderer preview harness has a `snippets` scene (`preview.html?hub=snippets`) with three saved snippets, the second switched off and the third formatted. It runs on a fake `window.voice`, so it proves layout and dialog flow, not storage or dictation.
