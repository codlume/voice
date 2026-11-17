# Model install

This chart follows one model row, Parakeet (the speech model) or S1-mini (the cleanup model), as it appears in Settings > Models and on Home's `Set up Voice` checklist. It covers install, download, a stalled or failed download, the hash check, loading, and uninstall. [The Models feature map](../features/models.md) says how to drive each step.

```mermaid
---
title: "Installing a model"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: idle
    lg1: busy
    lg2: ready
    lg3: failed
    lg4: Breaks WayOut
    lg5: Path to the WayOut bug
  }
  class lg0 tan
  class lg1 blue
  class lg2 teal
  class lg3 orange
  class lg4 breaks
  class lg5 bugPath
  s0: Loading
  s1: Not installed
  s2: Downloading
  s3: Failed
  s4: Installed
  s5: Uninstalling
  s6: Download stalled, Cancel offered
  s7: Download stalled, nothing to press
  s8: Checking the files
  [*] --> s0
  [*] --> s1
  s0 --> s3: the model fails to load
  s0 --> s4: the model loads
  s1 --> s2: you press Install or Download
  s2 --> s3: the server or connection fails
  s2 --> s5: you press Cancel [cleanup model]
  s2 --> s6: the connection stalls [cleanup model]
  s2 --> s8: the last byte arrives
  s2 --> s7: the connection stalls [speech model]
  s3 --> s5: you confirm Uninstall
  s3 --> s8: you press Retry [files on disk]
  s4 --> s5: you confirm Uninstall
  s3 --> s2: you press Retry
  s5 --> s1: the files are deleted
  s6 --> s2: bytes arrive again
  s6 --> s3: 30 s pass with no bytes
  s6 --> s5: you press Cancel
  s7 --> s2: bytes arrive again
  s7 --> s3: 4 tries time out, about 4 min
  s8 --> s0: every file matches its hash
  s8 --> s5: you press Cancel [cleanup model]
  s8 --> s3: a file does not match its hash
  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834
  class s0 blue
  class s1 tan
  class s1 bugPath
  class s2 blue
  class s2 bugPath
  class s3 orange
  class s4 teal
  class s5 blue
  class s6 blue
  class s7 blue
  class s7 breaks
  class s7 bugPath
  class s8 blue
```

## Rules

- `ReadyMeansComplete` holds. The row reads "Installed" only when every file is on disk with the right bytes.
- `WayOut` breaks. A stalled or failed download should always offer Retry or Cancel. A stalled speech download offers neither.
- `UninstallClears` holds. After you confirm Uninstall or press Cancel, the files are gone, the row reads "Not installed", and dictation no longer uses the model.
- `NoPartialUse` holds. Dictation never uses a partial download.
- `StallEnds` holds. A stall never keeps the row in "Downloading" for good, because each download gives up on its own.

## The `WayOut` break

0. Not installed
1. you press Install or Download: Downloading
2. the connection stalls [speech model]: Download stalled, nothing to press

Parakeet has no Cancel. While it downloads, Settings and Home show "Downloading" with no button. Main refuses an uninstall, and the helper ignores `asr.remove`. The row stays this way until the helper's fetcher gives up, after 4 tries that each time out. With URLSession's default 60 s idle timeout, that is about 4 minutes. Then the row shows the failure message and Retry. S1-mini shows Cancel during the same stall, and its download gives up after 30 s.

To verify, check that `modelView` and `checklist` give a speech row in `downloading` no actions. A cleanup row in `downloading` must give `Cancel`. `ModelFetcherTests.aConnectionBelowTheMinimumRateCountsAsTimedOut` checks the 4 tries.

## What dictation does while a model is not ready

The chart has no dictation step. With the speech model missing or failed, a dictation fails at once with "Set up the speech model in Voice first". While the speech model downloads, it fails with "The speech model is still downloading". While it loads, Voice records, and the transcript waits for the load to finish. With the cleanup model in any state but loaded, Voice inserts the raw transcript.

## What the model leaves out

- The Transform model on the same page.
- Cleanup turned off. The S1-mini row then reads "Installed. Loads when text cleanup is on." in place of "Installed", and Home hides the row.
- The first instant after launch, when every row reads "Not installed" before the check of the disk finishes.
- Uninstall refused while a dictation runs. The speech row disables Uninstall then.
- A failed delete during uninstall, and an S1-mini engine that stops after it has loaded and reloads.
- The few milliseconds between the files going and the row reading "Not installed". The model treats them as one step.
- Files damaged or deleted outside Voice.

## What the chart hides

Nothing. Every step has an arrow. "Checking the files" reads "Loading" on the speech row and "Downloading" on the cleanup row. Cancel there on the cleanup row deletes the S1-mini file, even a complete one that you retry after a load failure.

## Regenerate

Run the sync check in [README.md](README.md#keep-the-charts-true).
