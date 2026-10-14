# History

Home lists every dictation that produced a transcript, newest first, grouped under Today, Yesterday, and older dates. A transcript that never reached its target stays in the list, marked "Not inserted", so the user can copy it. By default the history lives in memory and a quit clears it. The menu bar's `Copy last transcript` copies the newest entry's text.

## Sub-features

- `history-empty`: before any dictation, the History card explains that dictations show up there, and no search field shows.
- `history-row`: after a session, a row appears under `TODAY` with the local time and the inserted text, line breaks kept.
- `history-not-inserted`: a session that ended `notInserted` keeps its row, marked "Not inserted".
- `history-copy`: clicking a row copies its text and briefly shows "Copied". The row's `Copy` button does the same from the keyboard.
- `history-copy-raw`: `Copy raw transcript` appears only when the raw transcript differs from the inserted text, and copies the raw transcript.
- `history-delete`: `Delete` removes the row at once.
- `history-actions-reveal`: a row's buttons fade in on hover or when a row button has keyboard focus.
- `history-search`: the search field at the right of the first day header filters rows by text or raw transcript, ignoring case. `⌘F` focuses it and selects its text, `Escape` clears it and leaves the field, and no hits read "No dictations match".
- `history-memory`: the header says "Kept in memory until you quit Voice". A relaunch clears the list.

## How to get to it (user POV)

- Voice window > `Home` > `History`.
- Menu bar icon > `Copy last transcript`. Agents can't drive this menu, so report it as unreached.

## Driving it with voice-verify

Preconditions: baseline. Producing a transcript needs `dictate`, so the [Dictation](./dictation.md) preconditions apply.

- **Empty state.** `vv click Home`, then `vv text`. The output includes "Your dictations show up here".
- **Produce a transcript.** `vv dictate long.wav`. With cleanup on, `latest.raw` differs from `latest.text`, and `latest.status` is `inserted`.
- **Row appears under Today.** `vv text` shows `TODAY`, a clock time, and `latest.text` under "History". Then `vv shot history-row`. Cross-check with `vv eval hub 'window.voice.getHistory()'`.
- **Click copies.** Save the clipboard first: `pbpaste > "$TMPDIR/vv-clip"`. Then `vv click 'css:main section[aria-labelledby=history] li p'`, `vv wait hub 'document.querySelector("main section[aria-labelledby=history] li").textContent.includes("Copied")'`, and compare `pbpaste` with `latest.text`. `vv click 'css:button[aria-label^="Copy raw transcript"]'` and compare `pbpaste` with `latest.raw`. Restore with `pbcopy < "$TMPDIR/vv-clip" && rm "$TMPDIR/vv-clip"`.
- **Search.** `vv type 'css:input[type=search]' zzz`, then `vv text` shows "No dictations match". `vv click Insights`, then `vv click Home`, resets the search.
- **Delete.** `vv click 'css:button[aria-label^="Delete dictation"]'`, then `vv text` shows the empty state again.
- **Memory only.** Dictate once, then `vv stop --keep-user-data`, `vv launch --keep-user-data`, `vv click Home`, and `vv text`. The empty state is back, and `<userData>/history.json` does not exist.
- **Layout without dictating.** The renderer preview harness has `preview.html?hub=history` (entries across three days, one not inserted, one with a different raw transcript) and `preview.html?hub=history-empty`. It runs on a fake `window.voice`, so it proves layout and interaction, not storage or dictation.

## Gotchas

- Copy writes the user's real clipboard. Save it before and restore it after, and never print or log the saved contents.
- `Copy raw transcript` exists only when the raw text differs from the inserted text. With cleanup off, or with an already clean `short.wav`, it is absent by design.
- Row buttons are named with the row's time, such as `Copy dictation from 11:44 AM`, so target them with a `css:` prefix match when only one row exists.
