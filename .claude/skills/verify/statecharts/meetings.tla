---- MODULE meetings ----
\* One meeting from Start to its final transcript, as apps/desktop/src/main/meeting-lifecycle.ts
\* steps it, meeting-recorder.ts runs its effects, and the helper records into mic.pcm and system.pcm.
\* meeting.json saves the meeting's audio state as one field: present, deleting or gone. Every delete
\* saves deleting first, removes every audio file, then saves gone, and recovery runs that delete again.

VARIABLES
    status,    \* the meeting's status; "resuming" and "reopening" are the code's starting from paused and from ready
    helper,    \* idle, opening (meeting.start sent and not answered) or capturing (appends to the files)
    late,      \* a meeting.start that the meeting no longer wants is still unanswered and can make mic.pcm
    intent,    \* you pressed Start or Resume and have not stopped or paused since
    audio,     \* meeting.json's audio field: none (no meeting), present, deleting or gone
    files,     \* the audio files on disk: none, empty, audio, or part (a failed delete removed some)
    removing,  \* a delete of every audio file is running (memory only)
    after,     \* none, or resume: Resume waits for this delete, then starts new files
    final,     \* everything recorded has a final transcript saved
    failed,    \* finalPassFailed: the notice offers Try again and Delete audio
    lost,      \* Voice dropped audio that had no final transcript without you asking
    tray,      \* the tray item's label
    stale,     \* the helper began appending to audio that has its final transcript and no Try again
    stray      \* a resume of a finished meeting ended and did not start deleting its files

vars == <<status, helper, late, intent, audio, files, removing, after, final, failed, lost, tray, stale, stray>>

Live == {"recording", "paused"}
Opening == {"starting", "resuming", "reopening"}
Finishing == {"finishing", "draining", "confirming", "finalizing"}
capturing == helper = "capturing"
Idle == removing = "idle"

TrayFor(s) ==
    IF s \in Live THEN "Stop meeting"
    ELSE IF s \in Opening THEN "Starting meeting..."
    ELSE "Start meeting"

\* Every step ends with this, after status', audio' and files' are set. byYou marks your own deletions.
Moved(byYou) ==
    /\ tray' = TrayFor(status')
    /\ lost' = (lost \/ (files = "audio" /\ ~final' /\ ~byYou /\
                  ((audio = "present" /\ audio' \in {"deleting", "gone", "none"})
                   \/ (audio \in {"present", "gone"} /\ files' # "audio"))))
    /\ stale' = (stale \/ (~capturing /\ helper' = "capturing" /\ files = "audio" /\ final /\ ~failed))
    /\ stray' = (stray \/ (status = "reopening" /\ status' = "ready" /\ ~failed /\ audio' # "deleting"))

Init ==
    /\ status = "none" /\ helper = "idle" /\ late = FALSE /\ intent = FALSE
    /\ audio = "none" /\ files = "none" /\ removing = "idle" /\ after = "none"
    /\ final = TRUE /\ failed = FALSE /\ lost = FALSE /\ tray = "Start meeting"
    /\ stale = FALSE /\ stray = FALSE

\* Tray Start meeting, the meeting shortcut, or the hub's Start meeting button.
YouStart ==
    /\ status = "none"
    /\ status' = "starting" /\ helper' = "opening" /\ intent' = TRUE /\ audio' = "present"
    /\ UNCHANGED <<late, files, removing, after, final, failed>>
    /\ Moved(FALSE)

HelperStarts ==
    /\ status \in Opening /\ helper = "opening"
    /\ helper' = "capturing" /\ files' = "audio" /\ final' = FALSE
    /\ UNCHANGED <<status, late, intent, audio, removing, after, failed>>
    /\ Moved(FALSE)

RecordingBegins ==
    /\ status \in Opening /\ capturing
    /\ status' = "recording"
    /\ UNCHANGED <<helper, late, intent, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

\* A new meeting that fails or is stopped before any audio is removed with its folder.
StartFails ==
    /\ status = "starting" /\ helper = "opening"
    /\ status' = "gone" /\ helper' = "idle" /\ intent' = FALSE /\ audio' = "none" /\ files' = "none"
    /\ final' = TRUE
    /\ UNCHANGED <<late, removing, after, failed>>
    /\ Moved(TRUE)

YouStopWhileStarting ==
    /\ status = "starting"
    /\ status' = "gone" /\ helper' = "idle" /\ intent' = FALSE /\ audio' = "none" /\ files' = "none"
    /\ final' = TRUE
    /\ UNCHANGED <<late, removing, after, failed>>
    /\ Moved(TRUE)

\* You press Pause, or the helper loses the microphone or system audio.
PauseOrLoss ==
    /\ status = "recording"
    /\ status' = "paused" /\ helper' = "idle" /\ intent' = FALSE
    /\ UNCHANGED <<late, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

\* Resume of a paused meeting, or of a finished one whose audio is kept for Try again, adds to its files.
YouResumeAppend ==
    /\ \/ status = "paused"
       \/ status = "ready" /\ failed /\ audio = "present" /\ Idle
    /\ status' = IF status = "paused" THEN "resuming" ELSE "reopening"
    /\ helper' = "opening" /\ intent' = TRUE
    /\ UNCHANGED <<late, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

\* Resume of a finished meeting whose audio is gone starts new files with a fresh audio.json.
YouResumeFresh ==
    /\ status = "ready" /\ audio = "gone" /\ Idle
    /\ status' = "reopening" /\ audio' = "present" /\ files' = "empty"
    /\ helper' = "opening" /\ intent' = TRUE
    /\ UNCHANGED <<late, removing, after, final, failed>>
    /\ Moved(FALSE)

\* Resume of a finished meeting whose delete is unfinished finishes it first (finishDelete), while
\* meeting.json still says ready.
YouResumeAfterDelete ==
    /\ status = "ready" /\ audio = "deleting" /\ Idle
    /\ removing' = "running" /\ after' = "resume"
    /\ UNCHANGED <<status, helper, late, intent, audio, files, final, failed>>
    /\ Moved(FALSE)

\* The delete removes every file. deleting becomes gone, unless an unanswered meeting.start can still
\* make a file, or a waiting Resume saves present and starts new files. While that start is
\* unanswered the audio stays deleting, so finishDelete refuses the waiting Resume.
AudioDeleted ==
    /\ removing = "running"
    /\ removing' = "idle" /\ after' = "none"
    /\ IF after = "resume" /\ ~late
         THEN /\ status' = "reopening" /\ audio' = "present" /\ files' = "empty"
              /\ helper' = "opening" /\ intent' = TRUE
         ELSE /\ files' = "none"
              /\ audio' = IF audio = "deleting" /\ ~late THEN "gone" ELSE audio
              /\ UNCHANGED <<status, helper, intent>>
    /\ UNCHANGED <<late, final, failed>>
    /\ Moved(FALSE)

FailedDelete(f) == IF f = "audio" THEN {"audio", "part"} ELSE {f}

\* The delete throws, possibly part way. audio stays deleting, and a waiting Resume is refused.
DeleteFails ==
    /\ removing = "running"
    /\ removing' = "idle" /\ after' = "none"
    /\ files' \in FailedDelete(files)
    /\ UNCHANGED <<status, helper, late, intent, audio, final, failed>>
    /\ Moved(FALSE)

\* Where a resume that ends before it records leaves the meeting. A finished meeting not kept for
\* Try again saves deleting in the same write as ready, and deletes.
Back(s, byYou) ==
    /\ status' = IF s = "resuming" THEN "paused" ELSE "ready"
    /\ helper' = "idle" /\ intent' = FALSE
    /\ late' = (late \/ helper = "opening")
    /\ IF s = "reopening" /\ ~failed
         THEN audio' = "deleting" /\ removing' = "running"
         ELSE UNCHANGED <<audio, removing>>
    /\ UNCHANGED <<files, after, final, failed>>
    /\ Moved(byYou)

ResumeFails ==
    /\ status \in {"resuming", "reopening"} /\ helper = "opening"
    /\ Back(status, FALSE)

YouPauseWhileResuming ==
    /\ status \in {"resuming", "reopening"}
    /\ Back(status, TRUE)

\* The unwanted meeting.start makes its empty mic.pcm after all. The helper always answers a start,
\* with meeting.started or meeting.failed, or exits; main answers each on a meeting it deletes with
\* the delete again.
LateFile ==
    /\ late /\ audio # "none"
    /\ late' = FALSE
    /\ files' = IF files = "none" THEN "empty" ELSE files
    /\ removing' = IF audio = "deleting" THEN "running" ELSE removing
    /\ UNCHANGED <<status, helper, intent, audio, after, final, failed>>
    /\ Moved(FALSE)

\* The unwanted start is answered without a file. A meeting still deleting deletes again, now that no
\* start can make a file, so it can save gone.
LateAnswer ==
    /\ late
    /\ late' = FALSE
    /\ removing' = IF audio = "deleting" THEN "running" ELSE removing
    /\ UNCHANGED <<status, helper, intent, audio, files, after, final, failed>>
    /\ Moved(FALSE)

YouStop ==
    /\ status \in Live \cup {"resuming"}
    /\ status' = "finishing" /\ intent' = FALSE
    /\ helper' = "idle" /\ late' = (late \/ helper = "opening")
    /\ UNCHANGED <<audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

TimeLimit ==
    /\ status = "recording"
    /\ status' = "finishing" /\ helper' = "idle" /\ intent' = FALSE
    /\ UNCHANGED <<late, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

CaughtUpShort ==
    /\ status = "finishing"
    /\ status' = "confirming"
    /\ UNCHANGED <<helper, late, intent, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

CaughtUp ==
    /\ status \in {"finishing", "draining"}
    /\ status' = "finalizing"
    /\ UNCHANGED <<helper, late, intent, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

YouKeep ==
    /\ status = "confirming"
    /\ status' = "finalizing"
    /\ UNCHANGED <<helper, late, intent, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

YouDiscard ==
    /\ status = "confirming"
    /\ status' = "gone" /\ audio' = "none" /\ files' = "none" /\ final' = TRUE
    /\ UNCHANGED <<helper, late, intent, removing, after, failed>>
    /\ Moved(TRUE)

\* One write saves the final transcript, ready, finalPassFailed null and audio deleting. Then the delete.
FinalSaved ==
    /\ status = "finalizing"
    /\ status' = "ready" /\ final' = TRUE /\ failed' = FALSE /\ audio' = "deleting" /\ removing' = "running"
    /\ UNCHANGED <<helper, late, intent, files, after>>
    /\ Moved(FALSE)

FinalFails ==
    /\ status = "finalizing"
    /\ status' = "ready" /\ failed' = TRUE
    /\ UNCHANGED <<helper, late, intent, audio, files, removing, after, final>>
    /\ Moved(FALSE)

\* Try again is offered only while the audio is present.
YouTryAgain ==
    /\ status = "ready" /\ failed /\ audio = "present" /\ Idle
    /\ status' = "finalizing"
    /\ UNCHANGED <<helper, late, intent, audio, files, removing, after, final, failed>>
    /\ Moved(FALSE)

\* Delete audio on the "final pass failed" notice, or on the "could not delete" notice of an unfinished
\* delete. One write clears finalPassFailed and saves deleting, so a failed delete never offers Try again.
YouDeleteAudio ==
    /\ status = "ready" /\ Idle
    /\ \/ failed /\ audio = "present"
       \/ audio = "deleting"
    /\ failed' = FALSE /\ audio' = "deleting" /\ removing' = "running"
    /\ UNCHANGED <<status, helper, late, intent, files, after, final>>
    /\ Moved(TRUE)

\* A delete cut off by a quit can leave any part of the files.
CutOff(f) ==
    CASE f = "audio" -> {"audio", "part", "none"}
      [] f = "part" -> {"part", "none"}
      [] f = "empty" -> {"empty", "none"}
      [] OTHER -> {"none"}

\* recover() finishes an unfinished meeting from its files, as hasAudio = files hold audio.
RecStatus(s, f) ==
    CASE s = "starting" /\ f # "audio" -> "gone"
      [] s = "reopening" /\ f # "audio" -> "ready"
      [] s \in Opening \cup Live \cup Finishing -> "draining"
      [] OTHER -> s

\* Then it sends audioFound to each meeting whose audio is deleting, or gone with files on disk, and
\* each deletes again. Returns <<audio, removing>>.
RecAudio(s, a, f, fl) ==
    LET st == RecStatus(s, f) IN
    IF st = "gone" THEN <<"none", "idle">>
    ELSE IF s = "reopening" /\ st = "ready" /\ ~fl THEN <<"deleting", "running">>
    ELSE IF a = "deleting" \/ (a = "gone" /\ f # "none") THEN <<"deleting", "running">>
    ELSE <<a, "idle">>

\* Voice quits or crashes, opens again, and runs recover().
VoiceRestarts ==
    /\ \/ status \in Opening \cup Live \cup Finishing
       \/ audio = "deleting" \/ (audio = "gone" /\ files # "none")
       \/ removing = "running" \/ late
    /\ \E f \in (IF removing = "running" THEN CutOff(files) ELSE {files}) :
         LET st == RecStatus(status, f)
             ra == RecAudio(status, audio, f, failed) IN
         /\ status' = st
         /\ audio' = ra[1] /\ removing' = ra[2]
         /\ files' = IF st = "gone" THEN "none" ELSE f
         /\ final' = IF st = "gone" THEN TRUE ELSE final
    /\ helper' = "idle" /\ late' = FALSE /\ intent' = FALSE /\ after' = "none"
    /\ UNCHANGED failed
    /\ Moved(FALSE)

Done ==
    /\ status \in {"ready", "gone"}
    /\ UNCHANGED vars

Next ==
    \/ YouStart \/ HelperStarts \/ RecordingBegins \/ StartFails \/ YouStopWhileStarting
    \/ PauseOrLoss \/ YouResumeAppend \/ YouResumeFresh \/ YouResumeAfterDelete
    \/ AudioDeleted \/ DeleteFails \/ ResumeFails \/ YouPauseWhileResuming \/ LateFile \/ LateAnswer
    \/ YouStop \/ TimeLimit \/ CaughtUpShort \/ CaughtUp \/ YouKeep \/ YouDiscard
    \/ FinalSaved \/ FinalFails \/ YouTryAgain \/ YouDeleteAudio
    \/ VoiceRestarts \/ Done

\* The helper records only after you press Start meeting or Resume.
RecordsOnlyWhenAsked == capturing => intent

\* The tray reads Stop meeting exactly while a meeting records or is paused.
TrayStopExactlyWhileLive == (tray = "Stop meeting") <=> (status \in Live)

\* While the helper records, the tray never offers Start meeting.
TrayNeverOffersStartWhileRecording == capturing => tray # "Start meeting"

\* A meeting reads Recording only while the helper records.
RecordingMeansCapturing == status = "recording" => capturing

\* Audio starts going only after its final transcript is saved.
AudioDeletedOnlyAfterFinal == audio \in {"deleting", "gone"} => final

\* Voice never drops audio that has no final transcript unless you asked.
VoiceKeepsUnfinishedAudio == ~lost

\* Once the final transcript is saved, files still on disk are being deleted or the next launch deletes them.
AudioGoneOnceFinal ==
    (status = "ready" /\ final /\ ~failed /\ files # "none")
        => (removing = "running" \/ RecAudio(status, audio, files, failed)[2] = "running")

\* A resume of a finished meeting that ends before it records deletes the files its start made.
EndedResumeDeletesItsFiles == ~stray

\* A resume never adds to audio that has its final transcript, unless it is kept for Try again.
NoStaleAppend == ~stale

\* Audio that a failed delete left part of only waits to be deleted.
PartialAudioIsOnlyDeleted == files = "part" => audio = "deleting"

\* No final pass runs over audio that a failed delete left part of.
NoFinalPassOnPartialAudio == status \in {"finalizing", "draining"} => files # "part"

\* The helper records only into audio that meeting.json says is present.
RecordsOnlyIntoPresentAudio == helper # "idle" => audio = "present"

\* A finished meeting keeps present audio only for Try again.
ReadyPresentOnlyForRetry == (status = "ready" /\ audio = "present") => failed

\* Audio files are on disk only while meeting.json says present or deleting, or a delete runs.
FilesOnlyWhenPresent == files # "none" => (audio \in {"present", "deleting"} \/ removing = "running")

\* Recovery as a function of what is on disk, then its delete succeeding or failing.
Saved == [s |-> status, a |-> audio, f |-> files, fl |-> failed]
RecOnce(p) ==
    LET st == RecStatus(p.s, p.f) ra == RecAudio(p.s, p.a, p.f, p.fl) IN
    [s |-> st, a |-> ra[1], f |-> IF st = "gone" THEN "none" ELSE p.f, fl |-> p.fl, r |-> ra[2]]
Deleted(q) ==
    IF q.r = "running"
      THEN [s |-> q.s, a |-> IF q.a = "deleting" THEN "gone" ELSE q.a, f |-> "none", fl |-> q.fl]
      ELSE [s |-> q.s, a |-> q.a, f |-> q.f, fl |-> q.fl]
NotDeleted(q) ==
    IF q.r = "running"
      THEN {[s |-> q.s, a |-> q.a, f |-> x, fl |-> q.fl] : x \in FailedDelete(q.f) \cup CutOff(q.f)}
      ELSE {[s |-> q.s, a |-> q.a, f |-> q.f, fl |-> q.fl]}
Recover(p) == Deleted(RecOnce(p))

\* Recovery twice ends where recovery once does, and a recovery whose delete fails or is cut off
\* ends there on the next launch.
RecoveryIdempotent ==
    /\ Recover(Recover(Saved)) = Recover(Saved)
    /\ \A q \in NotDeleted(RecOnce(Saved)) : Recover(q) = Recover(Saved)

====
