---- MODULE transforms ----
\* One Transforms run: the desktop run (apps/desktop/src/main/transform-run.ts and
\* transforms.ts) and the helper's read, write, and clipboard work
\* (native/voice-helper SelectionReader, Insertion, Pasteboard). The helper runs its
\* commands in the order they arrive, so a run's read waits behind an earlier run's write.
\* The helper starts no write later than 4 s after it received the insert (InsertDeadline),
\* and main waits 6.5 s (INSERT_TIMEOUT_MS), longer than the helper's worst-case answer for an
\* insert that wrote (insertMaxMs in test-fixtures/helper-protocol.json). So once main gave
\* up on a write, the helper can only refuse it.
EXTENDS Naturals

CONSTANT MaxRuns

VARIABLES
    on,             \* the Transforms switch
    phase,          \* the desktop run: idle, reading, rewriting, replacing, done
    outcome,        \* what the pill shows once the run is over
    cur,            \* the id of the latest run
    text,           \* the selection in the target app
    writeText,      \* what the helper was told to write
    helperRead,     \* the run whose selection read the helper has yet to start
    copyRun,        \* the run whose Cmd+C the helper posted and is waiting on
    helperWrite,    \* the run whose write the helper can still do
    clip,           \* what the clipboard holds
    restorePending, \* a paste's restore of the clipboard is scheduled
    escaped,        \* you pressed Escape during the run the pill shows
    kept            \* the Last transform panel holds this run's result

vars == <<on, phase, outcome, cur, text, writeText, helperRead, copyRun,
          helperWrite, clip, restorePending, escaped, kept>>

Running == {"reading", "rewriting", "replacing"}

Init ==
    /\ on = FALSE
    /\ phase = "idle"
    /\ outcome = "none"
    /\ cur = 0
    /\ text = "original"
    /\ writeText = "none"
    /\ helperRead = 0
    /\ copyRun = 0
    /\ helperWrite = 0
    /\ clip = "yours"
    /\ restorePending = FALSE
    /\ escaped = FALSE
    /\ kept = FALSE

End(o) == phase' = "done" /\ outcome' = o

\* A helper answer for run id. The desktop drops it unless that run is still reading.
Deliver(id, answer) ==
    IF phase = "reading" /\ cur = id
    THEN IF answer = "selected"
         THEN phase' = "rewriting" /\ UNCHANGED outcome
         ELSE End("unchanged")
    ELSE UNCHANGED <<phase, outcome>>

YouTurnTransformsOn ==
    /\ ~on
    /\ on' = TRUE
    /\ UNCHANGED <<phase, outcome, cur, text, writeText, helperRead, copyRun,
                   helperWrite, clip, restorePending, escaped, kept>>

\* followTransformSettings dispatches cancel, which ends only a read or a rewrite,
\* and clears Last transform.
YouTurnTransformsOff ==
    /\ on
    /\ on' = FALSE
    /\ kept' = FALSE
    /\ IF phase \in {"reading", "rewriting"}
       THEN End("cancelled")
       ELSE UNCHANGED <<phase, outcome>>
    /\ UNCHANGED <<cur, text, writeText, helperRead, copyRun, helperWrite, clip,
                   restorePending, escaped>>

\* A new run starts on fresh selected text.
YouPressTheShortcut ==
    /\ on
    /\ phase \in {"idle", "done"}
    /\ cur < MaxRuns
    /\ cur' = cur + 1
    /\ phase' = "reading"
    /\ outcome' = "none"
    /\ helperRead' = cur + 1
    /\ text' = "original"
    /\ escaped' = FALSE
    /\ kept' = FALSE
    /\ UNCHANGED <<on, writeText, copyRun, helperWrite, clip, restorePending>>

YouPressTheShortcutModelMissing ==
    /\ on
    /\ phase \in {"idle", "done"}
    /\ cur < MaxRuns
    /\ cur' = cur + 1
    /\ End("unchanged")
    /\ text' = "original"
    /\ escaped' = FALSE
    /\ kept' = FALSE
    /\ UNCHANGED <<on, writeText, helperRead, copyRun, helperWrite, clip,
                   restorePending>>

\* onHelperEvent drops a transform shortcut unless activity is idle.
YouPressAgain ==
    /\ phase \in Running
    /\ UNCHANGED vars

\* The helper sends cancel while its selection reader is active. step() honours it only
\* while reading or rewriting.
YouPressEscape ==
    /\ phase \in Running
    /\ escaped' = TRUE
    /\ IF phase \in {"reading", "rewriting"}
       THEN End("cancelled")
       ELSE UNCHANGED <<phase, outcome>>
    /\ UNCHANGED <<on, cur, text, writeText, helperRead, copyRun, helperWrite, clip,
                   restorePending, kept>>

\* The accessibility read touches no clipboard.
HelperReadsByAccessibility ==
    /\ helperRead # 0
    /\ helperWrite = 0
    /\ copyRun = 0
    /\ helperRead' = 0
    /\ \E answer \in {"selected", "nothing"} : Deliver(helperRead, answer)
    /\ UNCHANGED <<on, cur, text, writeText, copyRun, helperWrite, clip,
                   restorePending, escaped, kept>>

HelperPostsCopy ==
    /\ helperRead # 0
    /\ helperWrite = 0
    /\ copyRun = 0
    /\ copyRun' = helperRead
    /\ helperRead' = 0
    /\ clip' = "selection"
    /\ UNCHANGED <<on, phase, outcome, cur, text, writeText, helperWrite,
                   restorePending, escaped, kept>>

\* The copy watch outlives a cancelled read, so the clipboard goes back either way. A
\* pending paste restore is superseded by this one.
HelperGetsCopy ==
    /\ copyRun # 0
    /\ copyRun' = 0
    /\ clip' = "yours"
    /\ restorePending' = FALSE
    /\ \E answer \in {"selected", "nothing"} : Deliver(copyRun, answer)
    /\ UNCHANGED <<on, cur, text, writeText, helperRead, helperWrite, escaped, kept>>

ReadTimesOut ==
    /\ phase = "reading"
    /\ End("unchanged")
    /\ UNCHANGED <<on, cur, text, writeText, helperRead, copyRun, helperWrite, clip,
                   restorePending, escaped, kept>>

\* The engine's guard turns an empty or cut-off answer into "rejected".
RewriteFinishes ==
    /\ phase = "rewriting"
    /\ \E answer \in {"finished", "empty", "cut off"} :
         IF answer = "finished"
         THEN /\ phase' = "replacing"
              /\ writeText' = answer
              /\ helperWrite' = cur
              /\ kept' = on
              /\ UNCHANGED outcome
         ELSE /\ End("unchanged")
              /\ UNCHANGED <<writeText, helperWrite, kept>>
    /\ UNCHANGED <<on, cur, text, helperRead, copyRun, clip, restorePending, escaped>>

\* Too long, the engine stopped, or the budget ran out.
RewriteFails ==
    /\ phase = "rewriting"
    /\ End("unchanged")
    /\ UNCHANGED <<on, cur, text, writeText, helperRead, copyRun, helperWrite, clip,
                   restorePending, escaped, kept>>

\* The helper can write only while the desktop run still waits for it, so the answer always
\* reaches a run that is replacing.
HelperWriteLands ==
    /\ helperWrite # 0
    /\ helperWrite' = 0
    /\ text' = writeText
    /\ \/ UNCHANGED <<clip, restorePending>>
       \/ clip' = "rewrite" /\ restorePending' = TRUE
    /\ End("replaced")
    /\ UNCHANGED <<on, cur, writeText, helperRead, copyRun, escaped, kept>>

\* Focus moved, the selection changed, a secure field, or no editable target.
HelperWriteRefused ==
    /\ helperWrite # 0
    /\ helperWrite' = 0
    /\ End("notReplaced")
    /\ UNCHANGED <<on, cur, text, writeText, helperRead, copyRun, clip,
                   restorePending, escaped, kept>>

\* The 6.5 s insert watchdog. The helper's write deadline passed before it, so the helper
\* can no longer write. A refusal it still sends reaches a run that is over, and main drops it.
WriteTimesOut ==
    /\ phase = "replacing"
    /\ End("notReplaced")
    /\ helperWrite' = 0
    /\ UNCHANGED <<on, cur, text, writeText, helperRead, copyRun, clip, restorePending,
                   escaped, kept>>

HelperRestoresClipboard ==
    /\ restorePending
    /\ restorePending' = FALSE
    /\ clip' = "yours"
    /\ UNCHANGED <<on, phase, outcome, cur, text, writeText, helperRead, copyRun,
                   helperWrite, escaped, kept>>

PillHides ==
    /\ phase = "done"
    /\ phase' = "idle"
    /\ outcome' = "none"
    /\ escaped' = FALSE
    /\ UNCHANGED <<on, cur, text, writeText, helperRead, copyRun, helperWrite, clip,
                   restorePending, kept>>

Next ==
    \/ YouTurnTransformsOn
    \/ YouTurnTransformsOff
    \/ YouPressTheShortcut
    \/ YouPressTheShortcutModelMissing
    \/ YouPressAgain
    \/ YouPressEscape
    \/ HelperReadsByAccessibility
    \/ HelperPostsCopy
    \/ HelperGetsCopy
    \/ ReadTimesOut
    \/ RewriteFinishes
    \/ RewriteFails
    \/ HelperWriteLands
    \/ HelperWriteRefused
    \/ WriteTimesOut
    \/ HelperRestoresClipboard
    \/ PillHides

Spec == Init /\ [][Next]_vars

\* The selection only ever holds your text or a finished rewrite.
OnlyFinishedRewrite == text \in {"original", "finished"}

\* A pill that says the text was left alone (cancelled, refused, failed, not replaced) is true.
FailureLeavesText ==
    outcome \in {"cancelled", "unchanged", "notReplaced"} => text = "original"

\* Once the helper has no copy or paste in flight, the clipboard holds your contents.
ClipboardComesBack == (copyRun = 0 /\ ~restorePending) => clip = "yours"

\* The pill shows Replaced only when the selection holds the rewrite.
DoneMeansReplaced == outcome = "replaced" => text = "finished"

\* While a run works, no earlier run can still write to the text.
NoOverlap == phase \in Running => helperWrite \in {0, cur}

\* Escape during a run leaves the text unchanged.
EscapeLeavesText == escaped => text = "original"

\* "Result is in Voice" means the Last transform panel holds this run's result.
ResultIsInVoice == outcome = "notReplaced" => kept

====
