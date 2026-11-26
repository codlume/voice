---- MODULE dictation ----
\* One dictation session as main's session reducer (apps/desktop/src/main/session.ts) runs it,
\* with the helper's capture and insertion (native/voice-helper) reduced to the events they send.
\* A helper event and main's reaction to it are one step, and so are a command and the helper's
\* reaction, except an insertion and a transcription: main can give up on either while the
\* helper still works on it.
\* The helper starts no write later than 4 s after it received the insert (InsertDeadline),
\* and main waits 6.5 s (INSERT_TIMEOUT_MS), longer than the helper's worst-case answer for an
\* insert that wrote (insertMaxMs in test-fixtures/helper-protocol.json). So once main gave
\* up, the helper can only refuse.

VARIABLES
    phase,            \* main's session phase
    released,         \* in "starting": you let go before the mic delivered audio
    short,            \* in "starting" after an early release: you held under 250 ms
    intent,           \* you hold the key, or toggle is on, and have not pressed Escape
    mic,              \* the helper's capture for this session: "off", "opening", "on"
    helperInserting,  \* the helper still works on an insert command
    inApp,            \* the text reached the target app
    onClipboard,      \* main copied the text to the clipboard after a failed insert
    history,          \* this session's history entry: "none", "pending", "inserted", "notInserted",
                      \* "unconfirmed"
    heard,            \* the helper delivered a final transcript with words
    outcome,          \* in "done": what the Flow Bar reports
    lateTranscript    \* the helper still transcribes a session main gave up on; a new session
                      \* does not forget it

vars == <<phase, released, short, intent, mic, helperInserting, inApp, onClipboard, history,
          heard, outcome, lateTranscript>>

Init ==
    /\ phase = "idle"
    /\ released = FALSE
    /\ short = FALSE
    /\ intent = FALSE
    /\ mic = "off"
    /\ helperInserting = FALSE
    /\ inApp = FALSE
    /\ onClipboard = FALSE
    /\ history = "none"
    /\ heard = FALSE
    /\ outcome = "none"
    /\ lateTranscript = FALSE

\* What the Flow Bar shows: session.ts toPillState, then renderer/pillView.ts.
Pill ==
    CASE phase \in {"idle", "starting"} -> "idle"
      [] phase = "recording" -> "listening"
      [] phase \in {"transcribing", "cleaning", "inserting"} -> "processing"
      [] outcome = "inserted" -> "inserted"
      [] outcome = "notInserted" -> "notInserted"
      [] outcome = "unconfirmed" -> "notConfirmed"
      [] OTHER -> "message"

\* A new session forgets the last one, including an insertion the helper may still run.
Fresh ==
    /\ released' = FALSE
    /\ short' = FALSE
    /\ helperInserting' = FALSE
    /\ inApp' = FALSE
    /\ onClipboard' = FALSE
    /\ history' = "none"
    /\ heard' = FALSE
    /\ outcome' = "none"

\* session.ts finish() for an outcome that inserts nothing; dictation.ts finish() then settles
\* a pending history entry to notInserted.
Finish(o) ==
    /\ phase' = "done"
    /\ outcome' = o
    /\ mic' = "off"
    /\ history' = IF history = "pending" THEN "notInserted" ELSE history
    /\ UNCHANGED <<released, short, helperInserting, inApp, onClipboard, heard>>

EndWith(o) == Finish(o) /\ UNCHANGED lateTranscript

\* hotkeyDown or toggle while idle or done: capture.start. The model never has the speech
\* model missing, which ends the session at once without a capture.
YouPress ==
    /\ phase \in {"idle", "done"}
    /\ ~intent
    /\ phase' = "starting"
    /\ intent' = TRUE
    /\ mic' = "opening"
    /\ Fresh
    /\ UNCHANGED lateTranscript

\* endCapture in "starting": main records the release and sends the helper nothing.
YouLetGoEarly ==
    /\ phase = "starting"
    /\ intent
    /\ intent' = FALSE
    /\ released' = TRUE
    /\ short' \in BOOLEAN
    /\ UNCHANGED <<phase, mic, helperInserting, inApp, onClipboard, history, heard, outcome,
                   lateTranscript>>

\* stopOrCancel after 250 ms or more: capture.stop, and the helper transcribes.
YouLetGo ==
    /\ phase = "recording"
    /\ intent
    /\ phase' = "transcribing"
    /\ intent' = FALSE
    /\ mic' = "off"
    /\ UNCHANGED <<released, short, helperInserting, inApp, onClipboard, history, heard, outcome,
                   lateTranscript>>

\* stopOrCancel under 250 ms: capture.cancel, tooShort.
YouLetGoTooSoon ==
    /\ phase = "recording"
    /\ intent
    /\ intent' = FALSE
    /\ EndWith("tooShort")

\* The helper already ended this capture, so session.ts ignores the release.
YouLetGoAfterTheMicStopped ==
    /\ phase \notin {"starting", "recording"}
    /\ intent
    /\ intent' = FALSE
    /\ UNCHANGED <<phase, released, short, mic, helperInserting, inApp, onClipboard, history,
                   heard, outcome, lateTranscript>>

\* cancel (Escape, in either mode) or hotkeyChord (another key while holding): capture.cancel.
\* While transcribing, also once the transcription is overdue, the helper drops the transcript.
YouPressEscape ==
    /\ phase \in {"starting", "recording", "transcribing"}
    /\ phase' = "idle"
    /\ intent' = FALSE
    /\ mic' = "off"
    /\ released' = FALSE
    /\ short' = FALSE
    /\ UNCHANGED <<helperInserting, inApp, onClipboard, history, heard, outcome, lateTranscript>>

\* capture.started: the helper's first audio chunk.
MicRecords ==
    /\ phase = "starting"
    /\ ~released
    /\ phase' = "recording"
    /\ mic' = "on"
    /\ UNCHANGED <<released, short, intent, helperInserting, inApp, onClipboard, history, heard,
                   outcome, lateTranscript>>

\* capture.started after an early release of 250 ms or more: capture.stop.
MicRecordsAfterYouLetGo ==
    /\ phase = "starting"
    /\ released
    /\ ~short
    /\ phase' = "transcribing"
    /\ mic' = "off"
    /\ released' = FALSE
    /\ UNCHANGED <<short, intent, helperInserting, inApp, onClipboard, history, heard, outcome,
                   lateTranscript>>

\* capture.started after an early release under 250 ms: capture.cancel, tooShort.
MicRecordsAfterATap ==
    /\ phase = "starting"
    /\ released
    /\ short
    /\ EndWith("tooShort")
    /\ UNCHANGED intent

\* capture.failed (no permission, no device, the device changed while opening) or the 3 s
\* start watchdog, which also sends capture.cancel.
MicDoesNotStart ==
    /\ phase = "starting"
    /\ EndWith("failed")
    /\ UNCHANGED intent

\* capture.stopped: the device changed or the 10 minute cap. The key may still be down.
MicStopsOnItsOwn ==
    /\ phase = "recording"
    /\ phase' = "transcribing"
    /\ mic' = "off"
    /\ UNCHANGED <<released, short, intent, helperInserting, inApp, onClipboard, history, heard,
                   outcome, lateTranscript>>

\* transcript with words, cleanup (or an auto-applied transform) on: remember pending, clean.
HearsWordsCleanupOn ==
    /\ phase = "transcribing"
    /\ phase' = "cleaning"
    /\ heard' = TRUE
    /\ history' = "pending"
    /\ UNCHANGED <<released, short, intent, mic, helperInserting, inApp, onClipboard, outcome,
                   lateTranscript>>

\* transcript with words, cleanup off or the whole dictation is a snippet: remember, insert.
HearsWordsCleanupOff ==
    /\ phase = "transcribing"
    /\ phase' = "inserting"
    /\ heard' = TRUE
    /\ history' = "pending"
    /\ helperInserting' = TRUE
    /\ UNCHANGED <<released, short, intent, mic, inApp, onClipboard, outcome, lateTranscript>>

\* transcript with no words: empty, "Nothing heard".
HearsNothing ==
    /\ phase = "transcribing"
    /\ EndWith("empty")
    /\ UNCHANGED intent

\* transcript.failed.
TranscriptionFails ==
    /\ phase = "transcribing"
    /\ EndWith("failed")
    /\ UNCHANGED intent

\* The watchdog gives up after it marked the transcription overdue: failed "Transcription did
\* not finish", and capture.detach, so the helper keeps transcribing.
MainGivesUp ==
    /\ phase = "transcribing"
    /\ Finish("failed")
    /\ lateTranscript' = TRUE
    /\ UNCHANGED intent

\* The transcript of a session main gave up on: session.ts remembers it as notInserted and
\* changes nothing else, whatever the current session does. One with no words, or a late
\* transcript.failed, leaves no entry.
LateTranscriptArrives ==
    /\ lateTranscript
    /\ lateTranscript' = FALSE
    /\ UNCHANGED <<phase, released, short, intent, mic, helperInserting, inApp, onClipboard,
                   history, heard, outcome>>

\* cleaned with text: the cleaned text goes to insert.
CleanupReturnsText ==
    /\ phase = "cleaning"
    /\ phase' = "inserting"
    /\ helperInserting' = TRUE
    /\ UNCHANGED <<released, short, intent, mic, inApp, onClipboard, history, heard, outcome,
                   lateTranscript>>

\* cleanupFailed or the cleanup budget runs out: the raw text goes to insert.
CleanupFails ==
    /\ phase = "cleaning"
    /\ phase' = "inserting"
    /\ helperInserting' = TRUE
    /\ UNCHANGED <<released, short, intent, mic, inApp, onClipboard, history, heard, outcome,
                   lateTranscript>>

\* cleaned with no text (filler only): empty, and the raw text stays in history.
CleanupReturnsNothing ==
    /\ phase = "cleaning"
    /\ EndWith("empty")
    /\ UNCHANGED intent

\* insert.result accessibility or paste.
AppTakesText ==
    /\ phase = "inserting"
    /\ helperInserting
    /\ phase' = "done"
    /\ outcome' = "inserted"
    /\ inApp' = TRUE
    /\ history' = "inserted"
    /\ helperInserting' = FALSE
    /\ UNCHANGED <<released, short, intent, mic, onClipboard, heard, lateTranscript>>

\* insert.result none (focus changed, no text field, secure input, failed). With Copy to
\* clipboard on, main copies the text; the copy can fail.
AppRefusesText ==
    /\ phase = "inserting"
    /\ helperInserting
    /\ phase' = "done"
    /\ outcome' = "notInserted"
    /\ history' = "notInserted"
    /\ helperInserting' = FALSE
    /\ onClipboard' \in BOOLEAN
    /\ UNCHANGED <<released, short, intent, mic, inApp, heard, lateTranscript>>

\* insert.result none unconfirmed: the accessibility write ran out its 0.3 s timeout and nothing
\* shows it landed. The app may apply the queued write or drop it. Main ends notInserted with
\* reason unconfirmed, settles history to unconfirmed, and copies as for a failed insert.
AppDoesNotAnswer ==
    /\ phase = "inserting"
    /\ helperInserting
    /\ phase' = "done"
    /\ outcome' = "unconfirmed"
    /\ history' = "unconfirmed"
    /\ helperInserting' = FALSE
    /\ inApp' \in BOOLEAN
    /\ onClipboard' \in BOOLEAN
    /\ UNCHANGED <<released, short, intent, mic, heard, lateTranscript>>

\* The 6.5 s insert watchdog. The helper's write deadline passed before it, so the helper
\* writes nothing from here on.
InsertTimesOut ==
    /\ phase = "inserting"
    /\ phase' = "done"
    /\ outcome' = "notInserted"
    /\ history' = "notInserted"
    /\ onClipboard' \in BOOLEAN
    /\ UNCHANGED <<released, short, intent, mic, helperInserting, inApp, heard, lateTranscript>>

\* A late insert.result is a refusal, for example after a clipboard save that outlasted the
\* write deadline. Main logs it and changes nothing.
LateInsertRefused ==
    /\ phase # "inserting"
    /\ helperInserting
    /\ helperInserting' = FALSE
    /\ UNCHANGED <<phase, released, short, intent, mic, inApp, onClipboard, history, heard,
                   outcome, lateTranscript>>

\* helperExited. Before a transcript: failed "Voice helper stopped". After one: notInserted
\* with the uncleaned text, copied when Copy to clipboard is on. Idle or showing a result, main
\* ignores it. In every phase the crash loses a transcription main gave up on.
HelperCrashes ==
    /\ lateTranscript' = FALSE
    /\ \/ /\ phase \in {"starting", "recording", "transcribing"}
          /\ Finish("failed")
          /\ UNCHANGED intent
       \/ /\ phase \in {"cleaning", "inserting"}
          /\ phase' = "done"
          /\ outcome' = "notInserted"
          /\ history' = "notInserted"
          /\ helperInserting' = FALSE
          /\ onClipboard' \in BOOLEAN
          /\ UNCHANGED <<released, short, intent, mic, inApp, heard>>
       \/ /\ phase \in {"idle", "done"}
          /\ lateTranscript
          /\ UNCHANGED <<phase, released, short, intent, mic, helperInserting, inApp, onClipboard,
                         history, heard, outcome>>

\* idleTimeout, 1.3 s after an insert and 2.5 s after anything else.
FlowBarClears ==
    /\ phase = "done"
    /\ phase' = "idle"
    /\ mic' = "off"
    /\ UNCHANGED <<intent, lateTranscript>>
    /\ Fresh

Next ==
    \/ YouPress
    \/ YouLetGoEarly
    \/ YouLetGo
    \/ YouLetGoTooSoon
    \/ YouLetGoAfterTheMicStopped
    \/ YouPressEscape
    \/ MicRecords
    \/ MicRecordsAfterYouLetGo
    \/ MicRecordsAfterATap
    \/ MicDoesNotStart
    \/ MicStopsOnItsOwn
    \/ HearsWordsCleanupOn
    \/ HearsWordsCleanupOff
    \/ HearsNothing
    \/ TranscriptionFails
    \/ MainGivesUp
    \/ LateTranscriptArrives
    \/ CleanupReturnsText
    \/ CleanupFails
    \/ CleanupReturnsNothing
    \/ AppTakesText
    \/ AppRefusesText
    \/ AppDoesNotAnswer
    \/ InsertTimesOut
    \/ LateInsertRefused
    \/ HelperCrashes
    \/ FlowBarClears

Spec == Init /\ [][Next]_vars

\* The microphone is open only while you hold the key (or toggle is on) and have not pressed
\* Escape.
MicOnlyWhileYouAsk == mic # "off" => intent

\* The Flow Bar shows listening only while the microphone records.
ListeningMeansRecording == Pill = "listening" => mic = "on"

\* The Flow Bar or history says inserted only when the text reached the app.
InsertedMeansInApp == (Pill = "inserted" \/ history = "inserted") => inApp

\* The Flow Bar or history says not inserted only when the text is not in the app.
NotInsertedMeansNotInApp == (Pill = "notInserted" \/ history = "notInserted") => ~inApp

\* A final transcript with words always ends up in the app, on the clipboard, or in history,
\* including an unconfirmed entry.
TranscriptKept == heard => (inApp \/ onClipboard \/ history # "none")

====
