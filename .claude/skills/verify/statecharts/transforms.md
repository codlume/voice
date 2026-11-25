# Transforms run

This chart follows one Transforms run, from the shortcut to the outcome the Flow Bar pill shows. It covers the Transforms switch, Escape, the refusals, a failed rewrite, a refused or timed-out write, and the clipboard that the copy read and the paste borrow. [The Transforms feature map](../features/transforms.md) says how to drive each step.

```mermaid
---
title: "Transforms: rewrite the selection in place"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: idle
    lg1: running
    lg2: outcome
    lg3: Breaks EscapeLeavesText or ResultIsInVoice in some cases
    lg4: Path to the EscapeLeavesText or ResultIsInVoice bug
  }
  class lg0 tan
  class lg1 blue
  class lg2 teal
  class lg3 mayBreak
  class lg4 bugPath
  s0: Transforms off
  s1: Ready
  state "Pill shows the outcome" as s2 {
    s3: Refused or failed. Text unchanged
    s4: Cancelled. Text unchanged
    s5: Not replaced. Result is in Voice
    s6: Replaced
  }
  state "Pill shows the run working" as s7 {
    s8: Reading the selection
    s9: Rewriting
    s10: Replacing the selection
  }
  [*] --> s0
  s0 --> s1: you turn Transforms on
  s1 --> s0: you turn Transforms off
  s1 --> s3: you press Option+1 or Option+2 [model not set up]
  s1 --> s8: you press Option+1 or Option+2
  s8 --> s3: nothing selected, a secure field, or the read fails
  s8 --> s4: you press Escape or turn Transforms off
  s8 --> s9: Voice reads the selection
  s9 --> s3: the rewrite fails, is unusable, or is too long
  s9 --> s4: you press Escape or turn Transforms off
  s9 --> s10: the rewrite finishes
  s10 --> s5: the write is refused or times out
  s10 --> s6: the write lands
  s10 --> s10: you press Escape or turn Transforms off
  s5 --> s5: you turn Transforms off
  s2 --> s1: the pill hides
  s2 --> s8: you press Option+1 or Option+2
  s2 --> s0: the pill hides
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 tan
  class s0 bugPath
  class s1 tan
  class s1 bugPath
  class s3 teal
  class s4 teal
  class s5 teal
  class s5 mayBreak
  class s5 bugPath
  class s6 teal
  class s6 mayBreak
  class s6 bugPath
  class s8 blue
  class s8 bugPath
  class s9 blue
  class s9 bugPath
  class s10 blue
  class s10 bugPath
```

## Rules

- `OnlyFinishedRewrite` holds. The selection only ever holds your text or a finished rewrite. The engine's guard rejects an empty or cut-off answer, and the helper writes the whole result in one insert.
- `FailureLeavesText` holds. When the pill says the text was left alone (cancelled, refused, failed, or "Not replaced. Result is in Voice"), the text is unchanged.
- `ClipboardComesBack` holds. Once the helper has no Cmd+C or paste in flight, the clipboard holds your contents. A read cancelled during its Cmd+C still puts them back.
- `DoneMeansReplaced` holds. The pill shows the inserted outcome only after the helper reports the write.
- `NoOverlap` holds. While a run works, no earlier run can still write to the text. A second press during a run is dropped, and the helper starts no write after main gave up on it.
- `EscapeLeavesText` breaks. Escape during a run leaves the text unchanged.
- `ResultIsInVoice` breaks. When the pill says "Result is in Voice", the Last transform panel holds this run's result.

"Replacing the selection" and "Replaced" break `EscapeLeavesText` in some cases. "Not replaced. Result is in Voice" breaks `ResultIsInVoice` in some cases.

## The insert deadline (`FailureLeavesText`, `NoOverlap`)

0. Transforms off
1. you turn Transforms on: Ready
2. you press Option+1 or Option+2: Reading the selection
3. Voice reads the selection: Rewriting
4. the rewrite finishes: Replacing the selection
5. the write is refused or times out: Not replaced. Result is in Voice

Main gives the helper 6.5 s (`INSERT_TIMEOUT_MS`) to answer an insert. Then it ends the run as not inserted and sends `transform.end`. In the helper, `transform.end` clears the shelf and cancels only a read, so the helper holds a deadline of its own for a write. It starts no write later than 4 s after it read the `insert` line (`InsertDeadline`), and it asks right before the accessibility write and right before the paste's clipboard write and Cmd+V. An insert that ran out of time writes nothing and answers `insert.result` with method `none` and reason `failed`. So the text stays unchanged under a pill that says "Not replaced", and no write from an earlier run can land during a new run.

A write that starts just before the deadline answers at most 6.15 s after the helper read the line. `test-fixtures/helper-protocol.json` pins that bound as `insertMaxMs`, and main waits longer. [The dictation chart](dictation.md#the-insert-deadline-notinsertedmeansnotinapp) derives the number.

To verify, run `swift test --package-path native/voice-helper --filter "PasteKeystrokeTests|AccessibilityWriteTests|InsertDeadlineTests|InsertBudgetTests"` and the test "main waits for an insert longer than the helper can take to answer" in `apps/desktop/src/main/protocol.test.ts`.

## Escape during the write (`EscapeLeavesText`)

Steps 0 to 4 as above, then:

5. you press Escape or turn Transforms off: Replacing the selection
6. the write lands: Replaced

`step()` honors cancel only while reading or generating. The test "Escape once the write started changes nothing" pins this, so the code means it. The Transforms recipe says the same. The pill looks the same in all three running states, so you cannot see when Escape stops working.

## Transforms off and Last transform (`ResultIsInVoice`)

Steps 0 to 5 as in the insert deadline, then:

6. you turn Transforms off: Not replaced. Result is in Voice

Turning Transforms off clears Last transform at once, but the pill keeps "Result is in Voice" until it hides 2.5 s later. A second path turns Transforms off during "Replacing the selection". Main ignores the cancel there, clears the panel, and a refused write then shows "Result is in Voice" over an empty panel.

## What the model leaves out

- Model loading. "Rewriting" includes the "Loading model" pill, and the rewrite timeout starts only once the model is ready.
- Dictation. A shortcut is dropped while a dictation runs, and a dictation that starts hides the outcome pill.
- The shortcut disarm while the Voice window has focus, the editor, After dictation, and the log line.
- A helper crash. Main fails the run with "Voice helper stopped", and a paste restore that had not run is lost with the process.
- A clipboard that someone else changes during a copy or a paste. The helper then leaves it alone.
- A clipboard that holds a concealed item such as a password. The helper clears it rather than restoring it, by design.
- A target that answers the Cmd+C after the 1 s late check. Its answer stays on the clipboard.
- A target that reads the paste after the 1 s restore and pastes your old clipboard. The model counts a posted paste as a replacement.
- Time. Each wait is one step, so the model does not know that the 1.3 s pill outlasts the 1 s paste restore. It takes from the insert deadline that main gives up only after the helper can no longer write.
- An insert that the helper still holds after main gave up, for example behind a slow clipboard save. The helper refuses it, and a new run's read waits behind it.
- The helper's 50 ms re-read after an accessibility write that seems to change nothing. A write is one step.
- More than two runs.

## What the chart hides

- Steps that stay in one state. These are the helper's Cmd+C and its answer inside "Reading the selection", the paste restore, a second press during a run, and an answer for a run that is over.
- "you press Option+1 or Option+2 [model not set up]" from an outcome. It repeats the arrow from Ready.
- The exact pill text. "Refused or failed. Text unchanged" stands for "Select text first", "Can't read a secure field", "Click into the text first", "Release the keys, then try again", "Too long. Select up to N words", the model messages, and the failure messages. "Not replaced. Result is in Voice" stands for five write refusals.

## Regenerate

Run the sync check in [README.md](README.md#keep-the-charts-true).
