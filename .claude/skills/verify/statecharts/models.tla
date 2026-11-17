---- MODULE models ----
\* One on-device model row in Settings > Models and on the Home checklist: Parakeet (the speech
\* model, driven by the helper's Transcriber and ModelCache) or S1-mini (the cleanup model,
\* driven by apps/desktop/src/main/cleanup.ts and packages/cleanup/src/download.ts).

VARIABLES
    which,   \* "speech" or "cleanup"
    ui,      \* the row's status: "missing", "downloading", "loading", "ready", "failed"
    work,    \* what runs behind it: "none", "fetching", "stalled", "verifying", "loading", "removing"
    disk,    \* "none", "partial" (a .part file or some files), "complete" (every file, right bytes)
    engine,  \* TRUE when dictation can use the model
    removed  \* TRUE from a confirmed Uninstall or Cancel until the next Install or Retry

vars == <<which, ui, work, disk, engine, removed>>

\* modelView.ts and checklist.ts: the buttons a row shows for its status.
Offers ==
    CASE ui = "missing"     -> {"Install"}
      [] ui = "downloading" -> IF which = "cleanup" THEN {"Cancel"} ELSE {}
      [] ui = "loading"     -> {}
      [] ui = "ready"       -> {"Uninstall"}
      [] ui = "failed"      -> {"Retry", "Uninstall"}

\* At launch the helper sends asr.prepare(download: false) and cleanup runs loadIfDownloaded.
Init ==
    /\ which \in {"speech", "cleanup"}
    /\ disk \in {"none", "partial", "complete"}
    /\ IF disk = "complete"
          THEN ui = "loading" /\ work = "loading"
          ELSE ui = "missing" /\ work = "none"
    /\ engine = FALSE
    /\ removed = FALSE

\* Install, Download and Retry all call installModel. A complete copy is hashed first: the
\* helper's audit runs under "Loading", cleanup's matches() under "Downloading 0%".
YouInstall ==
    /\ work = "none"
    /\ ui \in {"missing", "failed"}
    /\ removed' = FALSE
    /\ IF disk = "complete"
          THEN /\ work' = "verifying"
               /\ ui' = IF which = "speech" THEN "loading" ELSE "downloading"
               /\ UNCHANGED disk
          ELSE /\ work' = "fetching"
               /\ ui' = "downloading"
               /\ disk' = "partial"
    /\ UNCHANGED <<which, engine>>

ConnectionStalls ==
    /\ work = "fetching"
    /\ work' = "stalled"
    /\ UNCHANGED <<which, ui, disk, engine, removed>>

BytesResume ==
    /\ work = "stalled"
    /\ work' = "fetching"
    /\ UNCHANGED <<which, ui, disk, engine, removed>>

\* Cleanup: 30 s with no bytes. Speech: URLSession's 60 s idle timeout, 4 attempts.
\* Both keep what arrived, so Retry resumes.
GiveUp ==
    /\ work = "stalled"
    /\ work' = "none"
    /\ ui' = "failed"
    /\ UNCHANGED <<which, disk, engine, removed>>

ConnectionFails ==
    /\ work = "fetching"
    /\ work' = "none"
    /\ ui' = "failed"
    /\ UNCHANGED <<which, disk, engine, removed>>

LastByte ==
    /\ work = "fetching"
    /\ work' = "verifying"
    /\ UNCHANGED <<which, ui, disk, engine, removed>>

\* Cleanup renames the .part into place only after its size and SHA-256 match. The helper
\* installs each staged file after its hash matches, then audits the folder again.
FilesMatch ==
    /\ work = "verifying"
    /\ work' = "loading"
    /\ ui' = "loading"
    /\ disk' = "complete"
    /\ UNCHANGED <<which, engine, removed>>

FileMismatch ==
    /\ work = "verifying"
    /\ disk = "partial"
    /\ work' = "none"
    /\ ui' = "failed"
    /\ disk' = IF which = "cleanup" THEN "none" ELSE "partial"
    /\ UNCHANGED <<which, engine, removed>>

ModelLoads ==
    /\ work = "loading"
    /\ work' = "none"
    /\ ui' = "ready"
    /\ engine' = TRUE
    /\ UNCHANGED <<which, disk, removed>>

LoadFails ==
    /\ work = "loading"
    /\ work' = "none"
    /\ ui' = "failed"
    /\ UNCHANGED <<which, disk, engine, removed>>

\* Cancel calls uninstallModel: it aborts the download, then removes the weights and .part.
YouCancel ==
    /\ "Cancel" \in Offers
    /\ work \in {"fetching", "stalled", "verifying"}
    /\ work' = "removing"
    /\ removed' = TRUE
    /\ UNCHANGED <<which, ui, disk, engine>>

\* Main refuses an uninstall while the row is loading, or downloading with no Cancel.
YouUninstall ==
    /\ "Uninstall" \in Offers
    /\ work = "none"
    /\ work' = "removing"
    /\ engine' = FALSE
    /\ removed' = TRUE
    /\ UNCHANGED <<which, ui, disk>>

FilesDeleted ==
    /\ work = "removing"
    /\ work' = "none"
    /\ disk' = "none"
    /\ ui' = "missing"
    /\ engine' = FALSE
    /\ UNCHANGED <<which, removed>>

Next ==
    \/ YouInstall
    \/ ConnectionStalls
    \/ BytesResume
    \/ GiveUp
    \/ ConnectionFails
    \/ LastByte
    \/ FilesMatch
    \/ FileMismatch
    \/ ModelLoads
    \/ LoadFails
    \/ YouCancel
    \/ YouUninstall
    \/ FilesDeleted

Spec == Init /\ [][Next]_vars /\ WF_vars(GiveUp)

\* The row says Installed only when every file is on disk with the right bytes.
ReadyMeansComplete == ui = "ready" => disk = "complete"

\* A stalled or failed download always offers Retry or Cancel.
WayOut ==
    (work = "stalled" \/ (ui = "failed" /\ work = "none")) =>
        Offers \cap {"Retry", "Cancel"} # {}

\* After Uninstall or Cancel the files are gone and the row stops saying Installed.
UninstallClears ==
    (removed /\ work # "removing") => (disk = "none" /\ ui = "missing" /\ ~engine)

\* Dictation never uses a partial download.
NoPartialUse == engine => disk = "complete"

\* A stall never holds the row in Downloading for good.
StallEnds == (work = "stalled") ~> (work # "stalled")

====
