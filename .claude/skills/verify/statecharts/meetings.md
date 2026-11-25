# Meeting recording

This chart follows one meeting from Start meeting (the tray item, the meeting shortcut or the hub's button) to its final transcript. It covers recording the microphone and system audio, pause and resume, Stop or the time limit, the live transcript catching up, `Started by mistake?`, the final pass, deleting the audio, resuming a finished meeting, and a quit or crash at any point followed by the next launch. [The Meetings feature map](../features/meetings.md) says how to drive each step.

```mermaid
---
title: "Meeting recording"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: Capture
    lg1: Finishing
    lg2: Done
    lg3: No meeting
    lg4: Breaks AudioDeletedOnlyAfterFinal or VoiceKeepsUnfinishedAudio
    lg5: Breaks AudioDeletedOnlyAfterFinal or NoFinalPassOnPartialAudio or PartialAudioIsOnlyDeleted or VoiceKeepsUnfinishedAudio in some cases
    lg6: Path to the AudioDeletedOnlyAfterFinal or NoFinalPassOnPartialAudio or PartialAudioIsOnlyDeleted or VoiceKeepsUnfinishedAudio bug
  }
  class lg0 orange
  class lg1 blue
  class lg2 teal
  class lg3 tan
  class lg4 breaks
  class lg5 mayBreak
  class lg6 bugPath
  s0: No meeting
  s1: Starting
  s2: Removed
  s3: Catching up the live transcript
  s4: Recording
  s5: Final pass
  s6: Paused
  s7: Started by mistake?
  s8: Ready, final pass failed, audio kept
  s9: Final transcript saved, deleting audio
  s10: Resuming
  s11: Deleting the kept audio
  s12: Ready, audio deleted
  s13: Ready, audio left on disk
  s14: Resuming a finished meeting
  s15: Ready, live transcript only, audio deleted
  s16: Live transcript only, deleting audio
  s17: Ready, final pass failed, part of the audio deleted
  s18: Ready, audio without a final transcript left on disk
  [*] --> s0
  s0 --> s1: you press Start meeting (tray, shortcut or hub)
  s1 --> s2: the start fails, you press Stop, or Voice closes before any audio
  s1 --> s1: the helper opens the microphone and system audio
  s1 --> s3: Voice quits or crashes after the audio began, then opens again
  s1 --> s4: recording begins
  s3 --> s5: the transcript catches up
  s4 --> s3: you press Stop, the time limit ends it, or Voice quits or crashes, then opens again
  s4 --> s6: you press Pause, or the audio stops
  s5 --> s8: the final pass fails
  s5 --> s9: the final transcript is saved
  s3 --> s7: the transcript catches up with under ten words
  s6 --> s3: you press Stop, or Voice quits or crashes, then opens again
  s6 --> s10: you press Resume
  s7 --> s2: you press Discard
  s7 --> s5: you press Keep
  s8 --> s11: you press Delete audio
  s8 --> s5: you press Try again
  s8 --> s14: you press Resume
  s9 --> s12: the audio files are deleted
  s9 --> s13: deleting fails
  s10 --> s3: you press Stop, or Voice quits or crashes, then opens again
  s10 --> s6: the resume fails, or you press Pause
  s11 --> s8: deleting fails, so Voice says it could not delete the audio
  s11 --> s15: the audio files are deleted
  s11 --> s16: Voice quits or crashes, then opens again
  s11 --> s17: deleting fails, so Voice says it could not delete the audio
  s12 --> s14: you press Resume
  s13 --> s9: Voice quits or crashes, then opens again
  s13 --> s14: you press Resume
  s14 --> s8: the resume fails, or you press Pause or Stop
  s14 --> s3: Voice quits or crashes, then opens again
  s10 --> s4: recording begins
  s15 --> s14: you press Resume
  s16 --> s15: the audio files are deleted
  s16 --> s18: deleting fails
  s17 --> s11: you press Delete audio
  s14 --> s12: the resume fails, or you press Pause or Stop or Voice quits or crashes, then opens again
  s14 --> s13: the audio left on disk cannot be deleted, so the resume fails
  s14 --> s4: recording begins
  s18 --> s16: Voice quits or crashes, then opens again
  s18 --> s14: you press Resume
  s14 --> s15: the resume fails, or you press Pause or Stop or Voice quits or crashes, then opens again
  s14 --> s18: the resume fails, or you press Pause or Stop or the audio left on disk cannot be deleted, so the resume fails
  s14 --> s14: the audio left on disk is deleted
  s11 --> s9: Voice quits or crashes, then opens again
  s11 --> s12: the audio files are deleted
  s5 --> s17: the final pass fails
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 tan
  class s0 bugPath
  class s1 orange
  class s1 bugPath
  class s2 tan
  class s2 mayBreak
  class s3 blue
  class s3 mayBreak
  class s3 bugPath
  class s4 orange
  class s4 mayBreak
  class s5 blue
  class s5 mayBreak
  class s5 bugPath
  class s6 orange
  class s6 mayBreak
  class s7 blue
  class s7 mayBreak
  class s8 teal
  class s8 mayBreak
  class s8 bugPath
  class s9 blue
  class s9 mayBreak
  class s10 orange
  class s10 mayBreak
  class s11 blue
  class s11 mayBreak
  class s11 bugPath
  class s12 teal
  class s12 mayBreak
  class s13 teal
  class s13 mayBreak
  class s14 orange
  class s14 mayBreak
  class s14 bugPath
  class s15 teal
  class s15 breaks
  class s15 bugPath
  class s16 blue
  class s16 mayBreak
  class s16 bugPath
  class s17 teal
  class s17 mayBreak
  class s17 bugPath
  class s18 teal
  class s18 mayBreak
  class s18 bugPath
```

## Rules

- `RecordsOnlyWhenAsked` holds. The helper records only after you press Start meeting or Resume, and not after you stop or pause. A relaunch never records. It finishes an unfinished meeting from its files and sends no `meeting.start`.
- `TrayStopExactlyWhileLive` holds. The tray item reads "Stop meeting" exactly while a meeting is recording or paused. It also reads "Stop meeting" while paused, because Stop then ends the paused meeting (`meetingToggle` in `shared/meetings.ts`). While a meeting starts or resumes, it reads "Starting meeting…" and does nothing.
- `TrayNeverOffersStartWhileRecording` holds. While the helper records, the tray never offers Start meeting.
- `RecordingMeansCapturing` holds. A meeting reads Recording only while the helper records.
- `AudioDeletedOnlyAfterFinal` breaks, by design. Audio is deleted only after its final transcript is saved, except when you press Delete audio on the "final pass failed" notice. That keeps the live transcript only.
- `VoiceKeepsUnfinishedAudio` breaks, by design. A quit, a crash, a relaunch or a failure never throws away audio that has no final transcript, except the audio of a cancelled resume. Voice deletes audio without a final transcript otherwise only after you press Delete audio, also when a relaunch finishes that delete. The helper only appends to `mic.pcm` and `system.pcm`, and a relaunch removes a meeting only when its files hold no audio.
- `AudioGoneOnceFinal` holds. Once the final transcript is saved, the next launch deletes any audio still on disk. A meeting keeps its audio after that only while the delete runs, or after the delete fails and until Voice opens again or you press Resume.
- `NoStaleAppend` holds. A resume never adds to audio that already has its final transcript, unless the final pass failed and the audio is kept for Try again. Resume on a finished meeting deletes the audio left on disk first, so the new leg starts new files.
- `PartialAudioIsOnlyDeleted` breaks, in one narrow case. Audio that a failed delete left part of only waits to be deleted. Voice never records onto it.
- `NoFinalPassOnPartialAudio` breaks in the same case. No final pass runs over audio that a failed delete left part of. Tracked in #451.

## The `AudioDeletedOnlyAfterFinal` break

0. No meeting
1. you press Start meeting (tray, shortcut or hub): Starting
2. the helper opens the microphone and system audio: Starting
3. Voice quits or crashes after the audio began, then opens again: Catching up the live transcript
4. the transcript catches up: Final pass
5. the final pass fails: Ready, final pass failed, audio kept
6. you press Delete audio: Deleting the kept audio
7. the audio files are deleted: Ready, live transcript only, audio deleted

The notice offers Try again and Delete audio. Delete audio first saves `meeting.json` with `finalPassFailed: null`, then removes `mic.pcm`, `system.pcm`, `output.ndjson` and `audio.json` and keeps the live transcript. `meeting-recorder.test.ts` checks this in "a failed final pass can be tried again, or its audio deleted, after a relaunch too".

If `rm` throws, `audioDeleteFailed` restores `finalPassFailed` and the notice, so Try again and Delete audio come back, and the command is refused with "The audio could not be deleted. Try again." The audio stays. `meeting-recorder.test.ts` checks this in "Delete audio whose delete fails is refused and keeps the audio and both actions".

The failed delete can be partial. It can remove `system.pcm` and keep `mic.pcm`. The chart shows this as "Ready, final pass failed, part of the audio deleted". Try again would run a final pass over `mic.pcm` alone. That pass would drop the live lines of the system audio, because it has no audio for them. Resume would add to the incomplete files, and the final pass after Stop would drop the same lines. So both refuse while a source has live lines but no audio on disk (`audioIncomplete` in `meeting-recorder.ts`). Delete audio stays offered. Once it succeeds, the meeting keeps its live transcript, and Resume starts new files. `meeting-recorder.test.ts` checks this in "after a partial Delete audio, Try again and Resume refuse and keep the deleted side's live lines". If Voice quits or crashes before the delete, the next launch finds a ready meeting with `finalPassFailed: null` and deletes its audio, as below.

## The `VoiceKeepsUnfinishedAudio` break

0. No meeting
1. you press Start meeting (tray, shortcut or hub): Starting
2. the helper opens the microphone and system audio: Starting
3. Voice quits or crashes after the audio began, then opens again: Catching up the live transcript
4. the transcript catches up: Final pass
5. the final pass fails: Ready, final pass failed, audio kept
6. you press Delete audio: Deleting the kept audio
7. Voice quits or crashes, then opens again: Live transcript only, deleting audio
8. deleting fails: Ready, audio without a final transcript left on disk
9. you press Resume: Resuming a finished meeting
10. the audio left on disk is deleted: Resuming a finished meeting

You pressed Delete audio, and Voice quit before the files were removed. The next launch deletes them as audio of a finished meeting. If that delete fails, the next Resume deletes them as leftover audio, which is what you asked for.

Pause or Stop while a finished meeting resumes returns it to `ready` with `finalPassFailed: null`. If the helper already opened the devices, the files hold the audio from that moment until `meeting.stop`. No leg holds it, because the meeting never showed Recording. The next Resume deletes it as leftover audio, and so does the next launch.

## The `PartialAudioIsOnlyDeleted` and `NoFinalPassOnPartialAudio` breaks

0. No meeting
1. you press Start meeting (tray, shortcut or hub): Starting
2. the helper opens the microphone and system audio: Starting
3. Voice quits or crashes after the audio began, then opens again: Catching up the live transcript
4. the transcript catches up: Final pass
5. the final pass fails: Ready, final pass failed, audio kept
6. you press Delete audio: Deleting the kept audio
7. deleting fails, so Voice says it could not delete the audio: Ready, final pass failed, part of the audio deleted
8. you press Delete audio: Deleting the kept audio
9. Voice quits or crashes, then opens again: Live transcript only, deleting audio
10. deleting fails: Ready, audio without a final transcript left on disk
11. you press Resume: Resuming a finished meeting
12. Voice quits or crashes, then opens again: Catching up the live transcript
13. the transcript catches up: Final pass

`audioIncomplete` checks only a meeting whose final pass failed. Here the second Delete audio already cleared `finalPassFailed`, so the incomplete audio counts as leftover audio. Resume deletes leftover audio before it records, which is safe. A quit in the moments before that delete finishes is not. The next launch sees a resuming meeting with audio and finishes it, so the final pass runs over the incomplete files and drops the deleted source's live lines. It takes two failed deletes and two quits at those exact moments. Tracked in #451.

## Leftover audio

On `finalized`, main writes `meeting.json` as finished (`ready`, or `summarizing` first when summaries are on) with `finalPassFailed: null`, and then it deletes the audio files. If `rm` throws, `runOrFail` only logs it, and nothing retries it while Voice runs. If Voice quits or crashes before the delete, the audio stays too.

Resume on a finished meeting with `finalPassFailed: null` deletes that audio before it sends `meeting.start` (`clearLeftoverAudio` in the `startCapture` effect). The new leg then starts new files with a fresh `audio.json`. If the delete throws, the resume fails before anything records. The meeting goes back to `ready` with the `resumeFailed` notice "Voice could not clear this meeting's old audio. Try again." `meeting-recorder.test.ts` checks this in "a resume after the audio delete failed starts new files instead of adding to the old ones" and "a resume whose leftover audio cannot be deleted does not record, and a later resume does".

On the next launch, `recover()` sends `audioFound` to each meeting whose files hold audio. A finished meeting with `finalPassFailed: null` then deletes its audio files. If that delete fails too, the launch after it tries again. A meeting whose final pass failed keeps its audio for Try again and Delete audio, and a resume adds to it. `meeting-recorder.test.ts` checks this in the tests whose names start with "a relaunch deletes the audio of".

## What the model leaves out

- The summary and the title after the final pass, and resuming a meeting while it writes its summary.
- Deleting a meeting from the list, retention expiry, and Discard sent by the API outside `Started by mistake?`.
- The silence prompt. Its 30 s stop is part of "the time limit ends it".
- A meeting that records the microphone only, because system audio is denied or unavailable.
- The echo gate and the voice detector. They decide which words reach the transcript, not which state the meeting is in. The `vv meeting` fixtures check them.
- The helper exit count. A drain or a final pass that loses the helper twice moves on or fails.
- A `meeting.started` that arrives after you paused. Main answers with `meeting.stop`.
- A start watchdog that fires while the helper already writes audio. The meeting is removed with its folder.
- Pause, Stop, or a start failure while Resume deletes the leftover audio. The delete runs first in `startCapture` and takes moments.
- Power loss. The helper syncs the files every 5 s, so the last seconds can go.
- Dictation markers, the notepad, the Flow Bar, and a second meeting. Only one meeting can be live.
- The model treats a quit, the next launch and `recover()` as one step. Start, Resume and the toggle wait behind `recover()`.

## What the chart hides

- A quit or crash in `Started by mistake?` or in Final pass. Both lead to "Catching up the live transcript", as from Paused.
- A quit or crash while catching up. It stays in "Catching up the live transcript".
- A quit or crash while deleting the audio. The next launch deletes it again, so it stays in "Final transcript saved, deleting audio" or "Live transcript only, deleting audio".

## Regenerate

Run the sync check in [README.md](README.md#keep-the-charts-true).
