# Meetings

A meeting records the user's microphone and the sound other apps play (other participants) until the user stops it, and transcribes both while it records. Mic speech is "You" and system audio is the other side. Pause and resume append to the same meeting. After Stop the transcript catches up and the meeting's audio files are deleted, leaving the transcript. A quit or crash mid-meeting is finished on the next launch from the files, without recording again. The Meetings page, notepad, and Flow Bar state are not built yet, so the hub API is the only entry point for now.

## Sub-features

- `meeting-record`: `startMeeting()` returns `{ kind: "ok", id }`, the meeting goes `starting` then `recording`, and `<userData>/meetings/<id>/` gains `mic.pcm` and `system.pcm` (16 kHz mono Int16) that grow as audio arrives.
- `meeting-live-transcript`: segments land in `transcript.ndjson` while recording (`getMeeting(id).transcript`), mic as `source: "mic"`, system as `source: "system"` with `speaker: null`.
- `meeting-echo`: with `meeting-mic-speakers.wav` the mic also hears the other side; those words appear once, as system segments, and main.log has `meeting echo dropped a N-word mic segment`.
- `meeting-stop`: `stopMeeting(id)` leads to `ready`, and the folder holds only `meeting.json` and `transcript.ndjson`.
- `meeting-short`: under ten transcribed words the meeting waits in `confirmingShort`; `keepMeeting` finishes it and `discardMeeting` deletes its folder.
- `meeting-dictated`: dictating while a meeting records inserts as usual and adds a `dictated` marker to the meeting transcript instead of the dictated words.
- `meeting-recovery`: a meeting left `recording` by a quit becomes `ready` on the next launch, its leg closed at the last audio write, and the helper plays no fixture and opens no device.

## How to get to it (user POV)

Not reachable from the UI yet. The Meetings page, the Option+M shortcut and the tray item come in later steps.

## Driving it with voice-verify

- `vv meeting [meeting-mic.wav|meeting-mic-speakers.wav] [--no-system]` copies the synthetic fixtures into the userData, starts a meeting through the hub API, waits until both fixtures have played (8x real time), stops it, keeps it if asked, and prints the transcript, the files left in the meeting's folder, and timings. Evidence JSON goes to the evidence dir.
- Dictation mid-meeting: copy both fixtures to `<userData>/meeting-mic.wav` and `meeting-system.wav`, `vv eval hub 'window.voice.startMeeting()'`, run `vv dictate short.wav`, stop the meeting, and read its transcript for the `dictated` marker.
- Recovery: start a meeting as above, `vv stop --keep-user-data` while it records, `vv launch --keep-user-data`, then `vv wait hub` for the meeting's status to be `ready` and list its folder.

## Gotchas

- Test mode never opens the microphone or a system audio tap. Without the fixture files in the userData, `meeting.start` fails with "meeting capture disabled" or reports system audio `unavailable`. A fixture run proves files, transcription, echo filtering, and lifecycle, not device or permission behavior.
- Markers use wall-clock meeting time and segments use audio time, so at 8x playback markers sort ahead of where they would land in a real-time meeting.
- Proven with `vv meeting meeting-mic-speakers.wav`, dictation mid-meeting, and recovery on 2026-10-31.
