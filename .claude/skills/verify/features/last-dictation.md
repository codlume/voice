# Last dictation

Home keeps the most recent transcript in memory, so a user can copy it if insertion didn't land. When cleanup changed the text, the user can also copy the raw transcript or switch the view to show it. The menu bar's `Copy last transcript` copies the cleaned text.

## Sub-features

- `last-empty`: before any dictation, the card explains that the last dictation will appear there.
- `last-show`: after a session, the card shows the cleaned text.
- `last-copy`: `Copy` puts the cleaned text on the clipboard and briefly reads `Copied`.
- `last-copy-raw`: `Copy raw` appears only when the raw transcript differs from the cleaned text, and copies the raw transcript.
- `last-show-raw`: the `Show raw transcript` toggle swaps the displayed text.
- `last-memory-only`: the card says "Kept in memory only". A relaunch clears it.

## How to get to it (user POV)

- Voice window > `Home` > `Last dictation`.
- Menu bar icon > `Copy last transcript`. Agents can't drive this menu, so report it as unreached.

## Driving it with voice-verify

Preconditions: baseline. Producing a transcript needs `dictate`, so the [Dictation](./dictation.md) preconditions apply.

- **Empty state.** `vv click Home`, then `vv text`. The output includes "Your last dictation shows up here".
- **Produce a transcript.** `vv dictate long.wav`. With cleanup on, `last.raw` differs from `last.text`.
- **Show it.** `vv text`. The output shows `last.text` under "Last dictation". Then `vv shot last-dictation`.
- **Show raw.** `vv click "Show raw transcript"`. Then `vv text` shows `last.raw`.
- **Copy.** Save the clipboard first: `pbpaste > "$TMPDIR/vv-clip"`. Then `vv click Copy`, `vv wait hub '[...document.querySelectorAll("button")].some(b => b.textContent === "Copied")'`, and compare `pbpaste` with `last.text` from `vv snapshot`. Restore with `pbcopy < "$TMPDIR/vv-clip" && rm "$TMPDIR/vv-clip"`.
- **Memory only.** `vv stop`, `vv launch`, `vv click Home`, then `vv text`. The empty state is back.

## Gotchas

- Copy writes the user's real clipboard. Save it before and restore it after, and never print or log the saved contents.
- `Copy raw` and the toggle exist only when the raw text differs from the cleaned text. With cleanup off, or with an already clean `short.wav`, they're absent by design.
