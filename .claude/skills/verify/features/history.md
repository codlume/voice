# History

Home lists every dictation that produced a transcript, newest first, grouped under Today, Yesterday, and older dates. A transcript that never reached its target stays in the list, marked "Not inserted", so the user can copy it. By default the history lives in memory and a quit clears it. In Settings > Data and Privacy the user can keep it for 24 hours, 30 days, or forever instead, saved on this Mac, and clear it. The menu bar's `Copy last transcript` copies the newest entry's text.

## Sub-features

- `history-empty`: before any dictation, the History card explains that dictations show up there, and no search field shows.
- `history-row`: after a session, a row appears under `TODAY` with the local time and the inserted text, line breaks kept.
- `history-not-inserted`: a session that ended `notInserted` keeps its row, marked "Not inserted".
- `history-copy`: clicking a row copies its text and briefly shows "Copied". The row's `Copy` button does the same from the keyboard.
- `history-copy-raw`: `Copy raw transcript` appears only when the raw transcript differs from the inserted text, copies the raw transcript, and briefly shows "Copied raw transcript".
- `history-delete`: `Delete` removes the row at once. With a saved history the file loses the entry first; if that fails the row stays, an error shows, and `Delete` again retries. A deleted session stays deleted when its cleanup lands a moment later.
- `history-show-more`: Home mounts at most 100 rows. A longer history ends in a `Show <n> more` button, where n is the hidden count up to 100, and search still covers every entry.
- `history-actions-reveal`: a row's buttons fade in on hover or when a row button has keyboard focus.
- `history-search`: the search field at the right of the History header filters rows by text or raw transcript, ignoring case. `⌘F` focuses it and selects its text, `Escape` clears it and leaves the field, and no hits read "No dictations match".
- `history-memory`: the header says "Kept in memory until you quit Voice". A relaunch clears the list, and no `history.json` exists. The file is the only record of the choice: no file means memory, and settings.json holds nothing about history.
- `history-saved`: with `Keep history` set to 24 hours, 30 days, or Forever, the header says "Saved on this Mac for 24 hours", "Saved on this Mac for 30 days", or "Saved on this Mac", `<userData>/history.json` holds `{ version, retention, entries }` with `retention` one of `day`, `month`, or `forever`, and a relaunch reads the window and the entries from it. A change between saved windows is one write of that file. An entry leaves the list and the file the moment its window ends, with one timer armed for the oldest entry and nothing polling in between, and expired entries never show even before that timer runs. The file is mode `0600`.
- `history-save-failed`: when `history.json` cannot be written, the header turns red and says "Could not save on this Mac, so kept until you quit". A file Voice cannot use (unreadable, not JSON, a newer version, or a missing or unknown `retention`) is left as it was, the run keeps history in memory with the same red header, `Keep history` shows `Until I quit Voice`, and only `Clear history` or a switch to `Until I quit Voice` removes it. A window chosen meanwhile is a label until then, and `Clear history` replaces the file with that window's empty one. Switching from `Until I quit Voice` onto such a file that appeared since launch leaves it alone the same way. No `history.json.*.tmp` stays behind after a failed write. A failed change of `Keep history` shows an error, nothing moves on disk, and the select stays on the old value.
- `history-shorten`: choosing a shorter window that would drop entries on screen asks first ("Keep history for 24 hours?" with "N older transcripts are deleted"); `Delete older` applies it. A longer window, and `Until I quit Voice`, apply at once.
- `history-back-to-memory`: switching `Keep history` back to `Until I quit Voice` deletes `history.json` at once and keeps the list on screen until the next quit.
- `history-clear`: Settings > Data and Privacy > `Clear history` asks to confirm, then empties the list and any `history.json.*.tmp`. With a saved window the file stays and holds no entries, so the window survives a relaunch; in memory mode, or for a file Voice could not use with no window chosen since, the file is deleted. A clear right after launch also covers entries the saved file had not yet loaded, and a transcript that arrives right after the clear is kept and saved. If the delete fails the rows stay and an error shows.
- `history-restart`: with a saved history, the update restart dialog offers only `Restart`, because the transcripts survive it. If saving failed, it asks for a copy as in memory mode. The open dialog closes if `Keep history` changes. The hub renders only once the history has loaded, so a restart asked from the tray with a cold hub sees the real newest entry. Main drains pending settings changes and history writes before it judges whether the transcript survives.

## How to get to it (user POV)

- Voice window > `Home` > `History`.
- Voice window > `Settings` > `Data and Privacy` > `History`: `Keep history` (`#setting-history-retention`) and `Clear history`.
- Menu bar icon > `Copy last transcript`, disabled while the history is empty. Agents can't drive this menu, so report it as unreached.

## Driving it with voice-verify

Preconditions: baseline. Producing a transcript needs `dictate`, so the [Dictation](./dictation.md) preconditions apply.

- **Empty state.** `vv click Home`, then `vv text`. The output includes "Your dictations show up here".
- **Produce a transcript.** `vv dictate long.wav`. With cleanup on, `latest.raw` differs from `latest.text`, and `latest.status` is `inserted`.
- **Row appears under Today.** `vv text` shows `TODAY`, a clock time, and `latest.text` under "History". Then `vv shot history-row`. Cross-check with `vv eval hub 'window.voice.getHistory()'`.
- **Click copies.** Save the clipboard first with `vv clipboard save`. Then `vv click 'css:main section[aria-labelledby=history] li:first-of-type p'`, `vv wait hub 'document.querySelector("main section[aria-labelledby=history] li").textContent.includes("Copied")'`, write `latest.text` to a file without echoing it, and `pbpaste | cmp - <that file>`. `vv click 'css:main section[aria-labelledby=history] li:first-of-type button[aria-label^="Copy raw transcript"]'` and compare against `latest.raw` the same way. Restore with `vv clipboard restore`.
- **Search.** `vv type 'css:input[type=search]' zzz`, then `vv text` shows "No dictations match". `vv click Insights`, then `vv click Home`, resets the search.
- **Delete.** `vv click 'css:main section[aria-labelledby=history] li:first-of-type button[aria-label^="Delete dictation"]'`. The row leaves, and with no rows left `vv text` shows the empty state again.
- **Show more.** Only reachable with more than 100 entries; `preview.html?hub=history-long` shows the button on fake data.
- **Memory only.** Dictate once, then `vv stop --keep-user-data`, `vv launch --keep-user-data`, `vv click Home`, and `vv text`. The empty state is back, and `<userData>/history.json` does not exist.
- **Saved across a relaunch.** `vv click Settings`, `vv click "Data and Privacy"`, `vv click css:#setting-history-retention`, `vv click "30 days"`. Check `retention` is `"month"` in `<userData>/history.json` and the file is mode `600` (`stat -f %Lp`). `vv click Back`, `vv click Home`, `vv dictate short.wav`, then `cat <userData>/history.json` shows one entry whose `id` matches `latest.id` (don't paste its text into notes). `vv stop --keep-user-data`, `vv launch --keep-user-data`, `vv click Home`, and `vv text` still shows the row under `TODAY` and "Saved on this Mac for 30 days".
- **Back to memory deletes the file.** On that instance, set `Keep history` to `Until I quit Voice`. `vv wait hub 'window.voice.getHistory().then(h => h.entries.length === 1)'` still passes, `test -e <userData>/history.json` fails right away, and `ls <userData>/history.json.*.tmp` finds nothing.
- **Shorten asks first.** With a saved entry older than a day (write one into `history.json` before `launch --keep-user-data`, or wait), pick `24 hours`: `vv text` shows "Keep history for 24 hours?" and `vv click "Delete older"` applies it. Picking `Forever` from `30 days` applies without a dialog.
- **Clear.** `vv click "Clear history"` (the row's `Clear…` button), `vv click Clear`, then `vv text` on Home shows the empty state. With a saved window `history.json` still names it and holds `"entries": []`; in memory mode the file is gone.
- **Layout without dictating.** The renderer preview harness has `preview.html?hub=history` (entries across three days, one not inserted, one with a different raw transcript), `preview.html?hub=history-empty`, `preview.html?hub=history-saved` (30-day retention), `preview.html?hub=history-save-failed` (the red header), and `preview.html?hub=setup-not-ready` (the checklist above the history). It runs on a fake `window.voice`, so it proves layout and interaction, not storage or dictation.

## Gotchas

- Copy writes the user's real clipboard. `vv clipboard save` before and `vv clipboard restore` after keep every type on it, including images and rich text, which `pbpaste` and `pbcopy` drop. Never print or log the saved contents.
- `Copy raw transcript` exists only when the raw text differs from the inserted text. With cleanup off, or with an already clean `short.wav`, it is absent by design.
- The scratch userData starts in memory mode. A recipe that sets `Keep history` leaves `history.json` behind until `stop` deletes the userData, so revert the setting or relaunch fresh before the next recipe.
- Row buttons are named with the row's time and an excerpt, such as `Copy dictation from 17:07: Hi Anna, can…`, so target them with a `css:` prefix match scoped to one row (`li:first-of-type`).
