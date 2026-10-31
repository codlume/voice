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
- `meeting-notepad`: a meeting that starts brings up the floating notepad (`notepad.html`, title "Meeting notepad") at the top right of the main display, or where the user last dragged it (`<userData>/notepad.json`), without taking focus from the frontmost app. It shows the status (`Starting…`, `Recording`, `Paused`, `Wrapping up…`, `Saved to Meetings`) with the meeting clock, `Pause` or `Resume` (icon buttons) and `Stop`, and the `Transcript` (live, You and Others, partials gray) and `My thoughts` tabs. My thoughts is the same text as the hub's tab, both ways. Closing it does not stop recording. A discarded meeting closes it.
- `meeting-pill`: with no dictation running, the Flow Bar shows the current meeting: a red light and the clock while recording, `Paused · <clock>`, `Starting…`, `Wrapping up…`, or a yellow light with a question. Dictation states replace it while dictating and it comes back after. Clicking it opens the notepad focused, without raising the Voice window.
- `meeting-prompts`: `Started by mistake?` (Keep, Discard) after a short recording, `Still in a meeting?` (Stop, Keep recording) after ten silent minutes, `Approaching the time limit` (End recording, Dismiss) five minutes before the maximum length, and notices such as a lost capture (Dismiss). The notepad comes up for the first three, and the Flow Bar asks the question in place of the clock.
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
- **Notepad and Flow Bar.** Copy both fixtures as above, `vv click Meetings`, start a meeting, then `vv eval notepad 'document.body.innerText'`, `vv click Pause notepad`, `vv shot notepad-paused notepad`, `vv shot pill-paused pill`, `vv eval pill 'window.voice.getPillSnapshot()'`. Stop it within a second of starting to reach `Started by mistake?`. `shot` captures the page only; for the window with its traffic lights, `screencapture -l <id>` with the id from `getMediaSourceId()` in the main process captures that one window.
- Recovery: start a meeting as above, `vv stop --keep-user-data` while it records, `vv launch --keep-user-data`, then `vv wait hub` for the meeting's status to be `ready` and list its folder.

## Gotchas

- Automatic folders only collect a meeting when a title is set. Folders made or edited later do not yet pick up existing meetings (main has no backfill yet).
- Test mode never opens the microphone or a system audio tap. Without the fixture files in the userData, `meeting.start` fails with "meeting capture disabled" or reports system audio `unavailable`. A fixture run proves files, transcription, echo filtering, and lifecycle, not device or permission behavior.
- Markers use wall-clock meeting time and segments use audio time, so at 8x playback markers sort ahead of where they would land in a real-time meeting.
- The silence prompt needs ten minutes of real time and the length warning at least 25 minutes, so a run proves them only by waiting; the unit tests in `meeting-focus.test.ts` and `MeetingNotepad.test.tsx` cover them.
- A pill click needs a real mouse event (CDP clicks skip the click-through handling); a CGEvent move then click over the capsule does it.
- Proven with `vv meeting meeting-mic-speakers.wav`, dictation mid-meeting, and recovery on 2026-10-31. Notepad, Flow Bar, pause, stop after pause, `Started by mistake?` and Discard, My thoughts sync, a real pill click and a real notepad drag proven on 2026-10-31.
