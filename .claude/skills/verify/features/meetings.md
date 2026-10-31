# Meetings

The Meetings page lists recorded meetings by day, newest first, with a search over titles, summaries, My thoughts and full transcripts. Hovering or focusing a row shows its title, date and overview (the summary's first paragraph, speaker names highlighted) in the panel on the right. Opening a meeting shows an editable title and the Summary, My thoughts and Transcript tabs, with Copy as Markdown, Export .md, Delete and the folder menu. Folders are manual or automatic (a word the title contains). The gear opens the meeting settings. Recording is not built yet: `Start meeting`, Pause, Resume, Stop and `Generate summary` answer that it is not available, and change nothing.

## Sub-features

- `meetings-list`: day groups (`Today`, `Yesterday`, then the date), each row with its start time, a status word while the meeting is not done, and an `Add to folder` menu on hover.
- `meetings-search`: `Search meetings` (Cmd+F) shows the matching meetings with where they matched (`Summary:`, `My thoughts:`, `Transcript:`) and a snippet, or "No meetings match".
- `meetings-overview`: the right panel; it hides under 720 px of page width.
- `meetings-detail`: title (Enter saves, Escape reverts, blank clears it), Summary states (writing, "New recording since this summary." with `Update summary`, failed with the previous summary under it, short meetings with `Generate summary`), My thoughts saved after a pause in typing and on leaving, Transcript with You, Others or a speaker name, times, and Dictated, Paused, Resumed and Audio lost markers.
- `meetings-delete`: "Delete “<title>”?" then `Delete` returns to the list.
- `meetings-folders`: `New folder`, edit, delete ("Only the folder is deleted. Its meetings stay."), the `Automatic folders` switch, and a folder's own list.
- `meetings-settings`: Maximum length, Ask after 10 minutes of silence, Open summary when ready, Keep meetings (with a sentence saying how long transcripts stay; a shorter choice that deletes meetings asks first), Automatic folders.
- `meetings-live`: while a meeting records, a card above the tabs shows its timer and Pause or Resume, and Stop.

## How to get to it (user POV)

- Voice window sidebar: `Meetings`, after Home.
- Keyboard: Cmd-2 in the Voice nav.

## Driving it with voice-verify

Preconditions: baseline. A fresh userData has no meetings.

- **Open Meetings.** `vv click Meetings`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Meetings"'` and `vv shot meetings-empty`. The page says "No meetings yet".
- **Start is refused.** `vv click "Start meeting"` (the header button), then `vv text` shows "Recording meetings is not available in this version of Voice yet." and `vv eval hub 'window.voice.getMeetings().then(s => s.meetings.length)'` is still 0.
- **Settings.** `vv click "Meeting settings"`, `vv click css:#meetings-retention`, `vv click "30 days"`; `vv text` shows "stay on this Mac for 30 days", and `<userData>/meetings/settings.json` holds `"retention": "month"`. `vv key Escape`.
- **Folders.** `vv click Folders`, `vv click "New folder"`, type a name, `vv click "Create folder"`; `<userData>/meetings/folders.json` lists it.
- **Layout with meetings.** The renderer preview harness has `preview.html?hub=meetings` (five synthetic meetings over three days, one in Polish, a stale summary, a failed summary, a short meeting without a summary, two folders), `preview.html?hub=meetings-recording` (the live card) and `preview.html?hub=meetings-empty`. It runs on a fake `window.voice`, so it proves layout and interaction, not storage or recording.

## Gotchas

- Until the recorder lands, a real instance can only show meetings written into `<userData>/meetings/` by hand. Use the preview for list, detail and summary states.
- Automatic folders only collect a meeting when a title is set. Folders made or edited later do not yet pick up existing meetings (main has no backfill yet).
