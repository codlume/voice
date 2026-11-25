---- MODULE meetings ----
\* One meeting from Start to its final transcript, as apps/desktop/src/main/meeting-lifecycle.ts
\* steps it, meeting-recorder.ts runs its effects, and the helper records into mic.pcm and system.pcm.

VARIABLES
    status,     \* the meeting's status; "resuming" and "reopening" are the code's starting from paused and from ready,
                \* and "clearingLeftover" is ready while Resume deletes the audio left on disk
    capturing,  \* the helper writes microphone and system audio to the meeting's files
    intent,     \* you pressed Start or Resume and have not stopped or paused since
    audio,      \* the meeting's audio files: never recorded, on disk, or deleted
    final,      \* everything recorded has a final transcript saved
    failed,     \* the final pass failed, so Try again and Delete audio are offered
    lost,       \* Voice dropped audio that had no final transcript without you asking
    tray,       \* the tray item's label
    stale,      \* the helper appended to audio that had a final transcript and no Try again
    partial     \* a failed delete already removed part of the kept audio, say system.pcm

vars == <<status, capturing, intent, audio, final, failed, lost, tray, stale, partial>>

Live == {"recording", "paused"}
Opening == {"starting", "resuming", "reopening"}

TrayFor(s) ==
    IF s \in Live THEN "Stop meeting"
    ELSE IF s \in Opening THEN "Starting meeting..."
    ELSE "Start meeting"

\* Every step ends with this, after status' and audio' are set. byYou marks your own deletions.
\* Part of the audio stays deleted for as long as the rest is kept.
Moved(byYou) ==
    /\ tray' = TrayFor(status')
    /\ lost' = (lost \/ (~byYou /\ audio = "kept" /\ ~final /\ (status' = "gone" \/ audio' # "kept")))
    /\ stale' = (stale \/ (~capturing /\ capturing' /\ final /\ ~failed /\ audio = "kept"))
    /\ partial' = (partial /\ audio' = "kept")

Init ==
    /\ status = "none"
    /\ capturing = FALSE
    /\ intent = FALSE
    /\ audio = "none"
    /\ final = TRUE
    /\ failed = FALSE
    /\ lost = FALSE
    /\ tray = "Start meeting"
    /\ stale = FALSE
    /\ partial = FALSE

\* Tray Start meeting, the meeting shortcut, or the hub's Start meeting button.
YouStart ==
    /\ status = "none"
    /\ status' = "starting"
    /\ intent' = TRUE
    /\ UNCHANGED <<capturing, audio, final, failed>>
    /\ Moved(FALSE)

\* A finished meeting still has audio on disk although its final pass did not fail.
Leftover == status = "ready" /\ ~failed /\ audio = "kept"

\* The helper's meeting.start opened the devices and appends to the files.
HelperStarts ==
    /\ status \in Opening
    /\ ~capturing
    /\ capturing' = TRUE
    /\ audio' = "kept"
    /\ final' = FALSE
    /\ UNCHANGED <<status, intent, failed>>
    /\ Moved(FALSE)

\* Main handles meeting.started.
RecordingBegins ==
    /\ status \in Opening
    /\ capturing
    /\ status' = "recording"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* meeting.failed, the 10 s start watchdog, or a helper exit while starting a new meeting.
StartFails ==
    /\ status = "starting"
    /\ ~capturing
    /\ status' = "gone"
    /\ intent' = FALSE
    /\ UNCHANGED <<capturing, audio, final, failed>>
    /\ Moved(FALSE)

\* Stop while a new meeting starts removes it; the helper gets meeting.stop after meeting.start.
YouStopWhileStarting ==
    /\ status = "starting"
    /\ status' = "gone"
    /\ capturing' = FALSE
    /\ intent' = FALSE
    /\ audio' = "none"
    /\ final' = TRUE
    /\ UNCHANGED failed
    /\ Moved(TRUE)

YouPause ==
    /\ status = "recording"
    /\ status' = "paused"
    /\ capturing' = FALSE
    /\ intent' = FALSE
    /\ UNCHANGED <<audio, final, failed>>
    /\ Moved(FALSE)

\* meeting.lost, meeting.failed or a helper exit while recording: an Audio lost marker, Paused.
AudioStops ==
    /\ status = "recording"
    /\ status' = "paused"
    /\ capturing' = FALSE
    /\ intent' = FALSE
    /\ UNCHANGED <<audio, final, failed>>
    /\ Moved(FALSE)

\* audioIncomplete refuses Resume while the audio kept for Try again is missing a part.
YouResume ==
    /\ status \in {"paused", "ready"}
    /\ ~(failed /\ partial)
    /\ ~Leftover
    /\ status' = IF status = "paused" THEN "resuming" ELSE "reopening"
    /\ intent' = TRUE
    /\ UNCHANGED <<capturing, audio, final, failed>>
    /\ Moved(FALSE)

\* Resume on such a meeting deletes that audio before it saves meeting.json as starting, so the
\* new leg starts new files. meeting.json still says ready while the delete runs.
YouResumeLeftover ==
    /\ Leftover
    /\ status' = "clearingLeftover"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

LeftoverDeleted ==
    /\ status = "clearingLeftover"
    /\ status' = "reopening"
    /\ intent' = TRUE
    /\ audio' = "deleted"
    /\ UNCHANGED <<capturing, final, failed>>
    /\ Moved(FALSE)

\* The delete throws: Resume is refused and nothing was saved, so the meeting stays ready.
LeftoverStays ==
    /\ status = "clearingLeftover"
    /\ status' = "ready"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* meeting.failed, the 10 s start watchdog, or a helper exit: back to where the resume began.
ResumeFails ==
    /\ status \in {"resuming", "reopening"}
    /\ ~capturing
    /\ status' = IF status = "resuming" THEN "paused" ELSE "ready"
    /\ intent' = FALSE
    /\ UNCHANGED <<capturing, audio, final, failed>>
    /\ Moved(FALSE)

\* Pause, or Stop while reopening, goes back to where the resume began.
YouPauseWhileResuming ==
    /\ status \in {"resuming", "reopening"}
    /\ status' = IF status = "resuming" THEN "paused" ELSE "ready"
    /\ capturing' = FALSE
    /\ intent' = FALSE
    /\ UNCHANGED <<audio, final, failed>>
    /\ Moved(FALSE)

\* Stop from Recording, Paused or Resuming: meeting.stop, then meeting.transcribe for the tail.
YouStop ==
    /\ status \in Live \cup {"resuming"}
    /\ status' = "finishing"
    /\ capturing' = FALSE
    /\ intent' = FALSE
    /\ UNCHANGED <<audio, final, failed>>
    /\ Moved(FALSE)

\* The maximum length, or the silence prompt left unanswered for 30 s.
TimeLimit ==
    /\ status = "recording"
    /\ status' = "finishing"
    /\ capturing' = FALSE
    /\ intent' = FALSE
    /\ UNCHANGED <<audio, final, failed>>
    /\ Moved(FALSE)

\* meeting.drained after Stop with under ten transcribed words.
CaughtUpShort ==
    /\ status = "finishing"
    /\ status' = "confirming"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* meeting.drained, the drain watchdog, or a second helper exit: main sends meeting.finalize.
CaughtUp ==
    /\ status \in {"finishing", "draining"}
    /\ status' = "finalizing"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

YouKeep ==
    /\ status = "confirming"
    /\ status' = "finalizing"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* Discard removes the meeting's folder.
YouDiscard ==
    /\ status = "confirming"
    /\ status' = "gone"
    /\ audio' = "none"
    /\ final' = TRUE
    /\ UNCHANGED <<capturing, intent, failed>>
    /\ Moved(TRUE)

\* applyFinalPass rewrites transcript.ndjson, then "finalized" persists the status before the
\* deleteAudio effect runs.
FinalSaved ==
    /\ status = "finalizing"
    /\ status' = "deletingAudio"
    /\ final' = TRUE
    /\ failed' = FALSE
    /\ UNCHANGED <<capturing, intent, audio>>
    /\ Moved(FALSE)

\* meeting.finalizeFailed, an empty pass the live transcript was unsure of, the final pass
\* watchdog, or a second helper exit. The live transcript and the audio stay.
FinalFails ==
    /\ status = "finalizing"
    /\ status' = "ready"
    /\ failed' = TRUE
    /\ UNCHANGED <<capturing, intent, audio, final>>
    /\ Moved(FALSE)

\* Audio with no final transcript gets here only after you pressed Delete audio and Voice
\* relaunched before the delete, because only Delete audio clears finalPassFailed without one.
AudioDeleted ==
    /\ status = "deletingAudio"
    /\ status' = "ready"
    /\ audio' = "deleted"
    /\ UNCHANGED <<capturing, intent, final, failed>>
    /\ Moved(~final)

\* rm throws: runOrFail logs it. The next resume or the next launch deletes the audio again.
DeleteFails ==
    /\ status = "deletingAudio"
    /\ status' = "ready"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* audioIncomplete refuses Try again while the kept audio is missing a part: a final pass over
\* what is left would drop the live lines of the source whose audio is gone.
YouTryAgain ==
    /\ status = "ready"
    /\ failed
    /\ ~partial
    /\ status' = "finalizing"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* The Delete audio action on the final pass failed notice. Main saves meeting.json with
\* finalPassFailed cleared before the deleteAudio effect removes the files.
YouDeleteAudio ==
    /\ status = "ready"
    /\ failed
    /\ status' = "deletingKeptAudio"
    /\ failed' = FALSE
    /\ UNCHANGED <<capturing, intent, audio, final>>
    /\ Moved(TRUE)

KeptAudioDeleted ==
    /\ status = "deletingKeptAudio"
    /\ status' = "ready"
    /\ audio' = "deleted"
    /\ UNCHANGED <<capturing, intent, final, failed>>
    /\ Moved(TRUE)

\* rm throws: audioDeleteFailed restores finalPassFailed and the notice, and the command is
\* refused. A partial delete can leave mic.pcm without system.pcm; the audio still counts as kept.
\* The audio stays kept, so Moved(FALSE) would change neither lost nor stale.
KeptAudioDeleteFails ==
    /\ status = "deletingKeptAudio"
    /\ status' = "ready"
    /\ failed' = TRUE
    /\ partial' \in {partial, TRUE}
    /\ tray' = TrayFor(status')
    /\ UNCHANGED <<capturing, intent, audio, final, lost, stale>>

\* Quit or crash: the helper exits on stdin EOF and its files keep what it appended. On the next
\* launch recover() sends "recover" with hasAudio from the files, before any start or resume. Then
\* it sends "audioFound" to each meeting whose files hold audio. A finished meeting with no failed
\* final pass answers with deleteAudio, so it deletes the audio again. That includes a meeting
\* whose Delete audio saved meeting.json and then quit before the files were removed, and a
\* meeting whose Resume quit while it deleted the audio left on disk.
Recovered(s) ==
    CASE s = "starting" /\ audio # "kept" -> "gone"
      [] s = "reopening" /\ audio # "kept" -> "ready"
      [] s \in {"deletingAudio", "deletingKeptAudio", "clearingLeftover", "ready"} -> "deletingAudio"
      [] OTHER -> "draining"

VoiceRestarts ==
    /\ \/ status \in Opening \cup Live \cup {"finishing", "draining", "confirming", "finalizing"}
       \/ status \in {"deletingAudio", "deletingKeptAudio", "clearingLeftover"}
       \/ Leftover
    /\ status' = Recovered(status)
    /\ capturing' = FALSE
    /\ intent' = FALSE
    /\ UNCHANGED <<audio, final, failed>>
    /\ Moved(FALSE)

Done ==
    /\ status \in {"ready", "gone"}
    /\ UNCHANGED vars

Next ==
    \/ YouStart \/ HelperStarts \/ RecordingBegins \/ StartFails \/ YouStopWhileStarting
    \/ YouPause \/ AudioStops \/ YouResume \/ YouResumeLeftover \/ LeftoverDeleted \/ LeftoverStays
    \/ ResumeFails
    \/ YouPauseWhileResuming
    \/ YouStop \/ TimeLimit \/ CaughtUpShort \/ CaughtUp \/ YouKeep \/ YouDiscard
    \/ FinalSaved \/ FinalFails \/ AudioDeleted \/ DeleteFails \/ YouTryAgain
    \/ YouDeleteAudio \/ KeptAudioDeleted \/ KeptAudioDeleteFails
    \/ VoiceRestarts \/ Done

\* Recording starts only from your Start or Resume, never from a relaunch or recovery.
RecordsOnlyWhenAsked == capturing => intent

\* The tray reads Stop meeting exactly while a meeting is recording or paused.
TrayStopExactlyWhileLive == (tray = "Stop meeting") <=> (status \in Live)

\* The tray never offers Start meeting while Voice records.
TrayNeverOffersStartWhileRecording == capturing => tray # "Start meeting"

\* Voice shows Recording only while the helper really records.
RecordingMeansCapturing == status = "recording" => capturing

\* Audio is deleted only after its final transcript is saved.
AudioDeletedOnlyAfterFinal == audio = "deleted" => final

\* A crash, a relaunch or a failure never throws away audio that has no final transcript.
VoiceKeepsUnfinishedAudio == ~lost

\* Once the final transcript is saved, the next launch deletes any audio still on disk.
AudioGoneOnceFinal ==
    (status \in {"ready", "deletingAudio", "clearingLeftover"} /\ final /\ ~failed /\ audio = "kept")
        => ENABLED (VoiceRestarts /\ status' = "deletingAudio")

\* A resume never appends to audio that has its final transcript and is not kept for Try again.
NoStaleAppend == ~stale

\* Audio a failed delete left part of only waits to be deleted.
PartialAudioIsOnlyDeleted ==
    partial => audio = "kept" /\ status \in {"ready", "deletingKeptAudio", "deletingAudio", "clearingLeftover"}

\* No final pass runs over audio a failed delete left part of.
NoFinalPassOnPartialAudio == partial => status # "finalizing"

====
