---- MODULE meetings ----
\* One meeting from Start to its final transcript, as apps/desktop/src/main/meeting-lifecycle.ts
\* steps it, meeting-recorder.ts runs its effects, and the helper records into mic.pcm and system.pcm.

VARIABLES
    status,     \* the meeting's status; "resuming" is the code's starting from paused
    capturing,  \* the helper writes microphone and system audio to the meeting's files
    intent,     \* you pressed Start or Resume and have not stopped or paused since
    audio,      \* the meeting's audio files: never recorded, on disk, or deleted
    final,      \* everything recorded has a final transcript saved
    failed,     \* the final pass failed, so Try again and Delete audio are offered
    lost,       \* Voice dropped audio that had no final transcript without you asking
    tray        \* the tray item's label

vars == <<status, capturing, intent, audio, final, failed, lost, tray>>

Live == {"recording", "paused"}
Opening == {"starting", "resuming"}

TrayFor(s) ==
    IF s \in Live THEN "Stop meeting"
    ELSE IF s \in Opening THEN "Starting meeting..."
    ELSE "Start meeting"

\* Every step ends with this, after status' and audio' are set. byYou marks your own deletions.
Moved(byYou) ==
    /\ tray' = TrayFor(status')
    /\ lost' = (lost \/ (~byYou /\ audio = "kept" /\ ~final /\ (status' = "gone" \/ audio' # "kept")))

Init ==
    /\ status = "none"
    /\ capturing = FALSE
    /\ intent = FALSE
    /\ audio = "none"
    /\ final = TRUE
    /\ failed = FALSE
    /\ lost = FALSE
    /\ tray = "Start meeting"

\* Tray Start meeting, the meeting shortcut, or the hub's Start meeting button.
YouStart ==
    /\ status = "none"
    /\ status' = "starting"
    /\ intent' = TRUE
    /\ UNCHANGED <<capturing, audio, final, failed>>
    /\ Moved(FALSE)

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

YouResume ==
    /\ status = "paused"
    /\ status' = "resuming"
    /\ intent' = TRUE
    /\ UNCHANGED <<capturing, audio, final, failed>>
    /\ Moved(FALSE)

ResumeFails ==
    /\ status = "resuming"
    /\ ~capturing
    /\ status' = "paused"
    /\ intent' = FALSE
    /\ UNCHANGED <<capturing, audio, final, failed>>
    /\ Moved(FALSE)

YouPauseWhileResuming ==
    /\ status = "resuming"
    /\ status' = "paused"
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

AudioDeleted ==
    /\ status = "deletingAudio"
    /\ status' = "ready"
    /\ audio' = "deleted"
    /\ UNCHANGED <<capturing, intent, final, failed>>
    /\ Moved(FALSE)

\* rm throws: runOrFail logs it, and the next launch deletes the audio again.
DeleteFails ==
    /\ status = "deletingAudio"
    /\ status' = "ready"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

YouTryAgain ==
    /\ status = "ready"
    /\ failed
    /\ status' = "finalizing"
    /\ UNCHANGED <<capturing, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* The Delete audio action on the final pass failed notice.
YouDeleteAudio ==
    /\ status = "ready"
    /\ failed
    /\ audio' = "deleted"
    /\ failed' = FALSE
    /\ UNCHANGED <<status, capturing, intent, final>>
    /\ Moved(TRUE)

\* Quit or crash: the helper exits on stdin EOF and its files keep what it appended. On the next
\* launch recover() sends "recover" with hasAudio from the files, before any start or resume. Then
\* it sends "audioFound" to each meeting whose files hold audio. A finished meeting with no failed
\* final pass answers with deleteAudio, so it deletes the audio again.
Recovered(s) ==
    CASE s = "starting" /\ audio # "kept" -> "gone"
      [] s \in {"deletingAudio", "ready"} -> "deletingAudio"
      [] OTHER -> "draining"

VoiceRestarts ==
    /\ \/ status \in Opening \cup Live \cup {"finishing", "draining", "confirming", "finalizing", "deletingAudio"}
       \/ status = "ready" /\ final /\ ~failed /\ audio = "kept"
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
    \/ YouPause \/ AudioStops \/ YouResume \/ ResumeFails \/ YouPauseWhileResuming
    \/ YouStop \/ TimeLimit \/ CaughtUpShort \/ CaughtUp \/ YouKeep \/ YouDiscard
    \/ FinalSaved \/ FinalFails \/ AudioDeleted \/ DeleteFails \/ YouTryAgain \/ YouDeleteAudio
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
AudioGoneOnceFinal == (final /\ audio = "kept") => ENABLED (VoiceRestarts /\ status' = "deletingAudio")

====
