# Meetings

The Meetings page lists recorded meetings by day, newest first, with a search over titles, summaries, My thoughts and full transcripts. Hovering or focusing a row shows its title, date and overview (the summary's first paragraph, speaker names highlighted) in the panel on the right. Opening a meeting shows an editable title and the Summary, My thoughts and Transcript tabs, with Copy as Markdown, Export .md, Delete and the folder menu. Folders are manual or automatic (a word the title contains). The gear opens the meeting settings.

A meeting records the user's microphone and the sound other apps play (other participants) until the user stops it, and transcribes both while it records. Mic speech is "You" and system audio is the other side. Pause and resume append to the same meeting. After Stop the transcript catches up and the meeting's audio files are deleted, leaving the transcript. A quit or crash mid-meeting is finished on the next launch from the files, without recording again.

## Sub-features

- `meetings-list`: day groups (`Today`, `Yesterday`, then the date), each row with its start time, a status word while the meeting is not done, and an `Add to folder` menu on hover.
- `meetings-search`: `Search meetings` (Cmd+F) shows the matching meetings with where they matched (`Summary:`, `My thoughts:`, `Transcript:`) and a snippet, or "No meetings match".
- `meetings-overview`: the right panel; it hides under 720 px of page width.
- `meetings-detail`: title (Enter saves, Escape reverts, blank clears it), Summary states (writing, "New recording since this summary." with `Update summary`, failed with the previous summary under it, short meetings with `Generate summary`), My thoughts saved after a pause in typing and on leaving, Transcript with You, Others or a speaker name, times, and Dictated, Paused, Resumed and Audio lost markers.
- `meetings-delete`: "Delete “<title>”?" then `Delete` returns to the list.
- `meetings-folders`: `New folder`, edit, delete ("Only the folder is deleted. Its meetings stay."), the `Automatic folders` switch, and a folder's own list.
- `meetings-settings`: Maximum length, Ask after 10 minutes of silence, Open summary when ready, Keep meetings (with a sentence saying how long transcripts stay; a shorter choice that deletes meetings asks first), Automatic folders.
- `meetings-live`: while a meeting records, a card above the tabs shows its timer and Pause or Resume, and Stop.
- `meeting-record`: `startMeeting()` returns `{ kind: "ok", id }`, the meeting goes `starting` then `recording`, and `<userData>/meetings/<id>/` gains `mic.pcm` and `system.pcm` (16 kHz mono Int16) that grow as audio arrives.
- `meeting-live-transcript`: segments land in `transcript.ndjson` while recording (`getMeeting(id).transcript`), mic as `source: "mic"`, system as `source: "system"` with `speaker: null`.
- `meeting-echo`: with `meeting-mic-speakers.wav` the mic also hears the other side; those words appear once, as system segments, and main.log has `meeting echo dropped a N-word mic segment`.
- `meeting-stop`: `stopMeeting(id)` leads to `ready`, and the folder holds only `meeting.json` and `transcript.ndjson`.
- `meeting-short`: under ten transcribed words the meeting waits in `confirmingShort`; `keepMeeting` finishes it and `discardMeeting` deletes its folder.
- `meeting-dictated`: dictating while a meeting records inserts as usual and adds a `dictated` marker to the meeting transcript instead of the dictated words.
- `meeting-recovery`: a meeting left `recording` by a quit becomes `ready` on the next launch, its leg closed at the last audio write, and the helper plays no fixture and opens no device.

## How to get to it (user POV)

- Voice window sidebar: `Meetings`, after Home.
- Keyboard: Cmd-2 in the Voice nav.

## Driving it with voice-verify

Preconditions: baseline. A fresh userData has no meetings.

- **Open Meetings.** `vv click Meetings`, then `vv wait hub 'document.querySelector("main h1")?.textContent === "Meetings"'` and `vv shot meetings-empty`. The page says "No meetings yet".
- **Settings.** `vv click "Meeting settings"`, `vv click css:#meetings-retention`, `vv click "30 days"`; `vv text` shows "stay on this Mac for 30 days", and `<userData>/meetings/settings.json` holds `"retention": "month"`. `vv key Escape`.
- **Folders.** `vv click Folders`, `vv click "New folder"`, type a name, `vv click "Create folder"`; `<userData>/meetings/folders.json` lists it.
- **Layout with meetings.** The renderer preview harness has `preview.html?hub=meetings` (five synthetic meetings over three days, one in Polish, a stale summary, a failed summary, a short meeting without a summary, two folders), `preview.html?hub=meetings-recording` (the live card) and `preview.html?hub=meetings-empty`. It runs on a fake `window.voice`, so it proves layout and interaction, not storage or recording.
- `vv meeting [meeting-mic.wav|meeting-mic-speakers.wav] [--no-system]` copies the synthetic fixtures into the userData, starts a meeting through the hub API, waits until both fixtures have played (8x real time), stops it, keeps it if asked, and prints the transcript, the files left in the meeting's folder, and timings. Evidence JSON goes to the evidence dir.
- Dictation mid-meeting: copy both fixtures to `<userData>/meeting-mic.wav` and `meeting-system.wav`, `vv eval hub 'window.voice.startMeeting()'`, run `vv dictate short.wav`, stop the meeting, and read its transcript for the `dictated` marker.
- Recovery: start a meeting as above, `vv stop --keep-user-data` while it records, `vv launch --keep-user-data`, then `vv wait hub` for the meeting's status to be `ready` and list its folder.

## Gotchas

- Automatic folders only collect a meeting when a title is set. Folders made or edited later do not yet pick up existing meetings (main has no backfill yet).
- Test mode never opens the microphone or a system audio tap. Without the fixture files in the userData, `meeting.start` fails with "meeting capture disabled" or reports system audio `unavailable`. A fixture run proves files, transcription, echo filtering, and lifecycle, not device or permission behavior.
- Markers use wall-clock meeting time and segments use audio time, so at 8x playback markers sort ahead of where they would land in a real-time meeting.
- Proven with `vv meeting meeting-mic-speakers.wav`, dictation mid-meeting, and recovery on 2026-10-31.
