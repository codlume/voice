# Acceptance runs

This is the reproducible preparation for measured acceptance ([#39](https://github.com/codlume/voice/issues/39), [#40](https://github.com/codlume/voice/issues/40)). Nothing here authorizes spending. A dry run establishes no live quality, insertion timing, or whole-app acceptance.

- `fixtures.json` freezes every fixture: SHA-256, duration class, source archive and path, spoken and intended references, expected outcome, and provenance. It holds the 35 published r2 fixtures ([#23](https://github.com/codlume/voice/issues/23#issuecomment-5761193088)) and 10 held-out fixtures from `heldout.json`. Never edit a reference to match provider output. `identifier` keeps its source; `fix` → `fixed` is reported as the accepted known failure.
- `plan.json` freezes the stages, the order seeds, success counts, attempt slots, caps, thresholds, conditions, and cost inputs. Any change there produces a different manifest hash and needs its own recorded decision.

Audio is never committed. It lives in `.acceptance/`, which also holds manifests and run evidence.

## Commands

```sh
node scripts/acceptance/cli.mjs recover        # download, hash-check, extract, verify all fixtures
pnpm build:desktop && pnpm package:desktop
node scripts/acceptance/cli.mjs manifest --mode dry-run [--stages a,b] [--successes n] [--max-attempts n]
node scripts/acceptance/cli.mjs run --manifest <file> [--target textedit]
node scripts/acceptance/cli.mjs verify --run .acceptance/runs/<run>
node scripts/acceptance/cli.mjs cost --manifest <file>
node --test scripts/acceptance/*.test.mjs
```

`recover` needs `gh` signed in to fetch the private attachments. The held-out archive (`heldout-01`) has no attachment URL yet. Until the maintainer attaches it to [#38](https://github.com/codlume/voice/issues/38) and records the URL in `fixtures.json`, put that exact file in `.acceptance/archives/`. Regenerating it with macOS `say` produces different hashes, so a regenerated set is a new fixture set, not a recovery.

A manifest binds the commit, a clean or dirty tree, the packaged `app.asar` and helper hashes, the exact Deepgram URL and model pin, and every fixture hash. It also binds the run order, duration classes, expected outcomes, caps, and declared conditions. `run` refuses a manifest whose build or fixtures differ.

## What a run drives

The runner starts the packaged app with isolated test storage and a test Keychain service. The helper's synthetic capture plays the fixture WAV at real time, then silence. Main's shortcut handler receives `hold.down` and `hold.up` through the test hook. The provider worker streams to Deepgram, or to a loopback stand-in in dry runs and loopback stages. The helper validates the original target and inserts. Main records monotonic `process.hrtime` marks for shortcut, first frame, capture stop, provider start and completion or failure, insertion, and ready. The runner reads those marks and never infers readiness from sleeps.

Input is virtual. It proves nothing about a physical microphone. Shortcuts use the test hook, not the native key tap. Both are real-machine checks in #40.

- **Target.** `--target textedit` opens a scratch TextEdit document, clears it before each session, and reads its text back after. A latency sample needs the helper's `inserted` result, the readback containing the final text, and exactly one provider request. Without a target, the Voice window stays in front and every result goes to recovery. That is honest, but it yields no latency samples.
- **Stop.** Stop is the earlier of `hold.up` and the helper's capture stop at the five-minute cap.
- **Order and slots.** Each normal stage runs its fixed slots in order until the required number of successful samples is reached or the slots are used up. Every attempt is appended to `ledger.jsonl`, including failures and refusals. Failed slots are never replaced.
- **Admission.** Before each dispatch, the attempt's worst case, one request plus its one permitted replay, must fit the remaining request, audio, and replay caps. Otherwise the stage stops and records why.
- **Report.** `report.json` and `REPORT.md` give attempts, successes, nearest-rank p95, median, accepted thresholds, and every failure. They list the known exception and fixtures needing review separately, along with the returned model UUIDs. A fixture needs review when its text differs from the spoken reference in any way beyond case and punctuation. Replay, recovery, and fault outcomes never count as latency samples.
- **Evidence.** `ARTIFACTS.sha256` covers the run. `verify` recomputes the report from the ledger and rejects credential-like text.

## Live mode

A live manifest (`--mode live`) comes only from the unmodified plan, on a clean committed build. `run` refuses to dispatch unless `--authorization` names a file that meets all of these:

```json
{
  "manifestSha256": "<exact manifest hash>",
  "stage": "<stage name>",
  "approved": true,
  "decision": "https://github.com/codlume/voice/issues/<n>#issuecomment-<id>",
  "caps": { "maxRequests": 0, "maxAudioSeconds": 0, "maxReplays": 0 }
}
```

The authorization caps may not exceed the manifest's. Before dispatch, the operator rechecks these on the account and records them in the decision: MIP opt-out, EU region, effective rate, remaining credit, and that the pinned model is available. Live mode also needs `--network` describing the declared network condition. The key is typed at a hidden prompt. It goes only into the isolated test Keychain, through the in-app `credential.set` command, and is removed when the run ends. Keys never go in files, arguments, environment variables, chat, or evidence. The provider adapter accepts only results carrying the pinned model UUID and version, so a substituted model fails the attempt instead of passing.

## Run protocol

Timing stages (`plan.json`):

| Stage                             | Provider            |      Samples | Slots | Accepted                                                             |
| --------------------------------- | ------------------- | -----------: | ----: | -------------------------------------------------------------------- |
| normal-short (≤30 s, 27 fixtures) | Deepgram            |           20 |    27 | stop→insertion median ≤700 ms, p95 ≤2 s                              |
| normal-intermediate (60–90 s)     | Deepgram            |           20 |    22 | p95 ≤5 s                                                             |
| normal-five-minute (300 s, cap)   | Deepgram            |           20 |    22 | p95 ≤5 s                                                             |
| negative (silence/noise)          | Deepgram            | quality only |     6 | no text, no insertion                                                |
| cold-launch                       | loopback            |           20 |    24 | launch→ready p95 ≤3 s                                                |
| warm-start                        | loopback            |           20 |    24 | shortcut→first frame p95 ≤150 ms                                     |
| faults                            | loopback, simulated |    pass/fail |     5 | drop→one replay; deadline→recoverable; rejected key; cancel; silence |

Launch and first-frame timing do not depend on the provider, so those stages use loopback and cost nothing. Ready is main's own mark after the helper, storage, setup refresh, and shortcut sync. It is measured from the runner's clock just before launch, on the same monotonic clock.

Resource runs (#39) use the same packaged build and fresh test storage:

- Sum the OS physical footprint of every Voice-owned process: main, renderers, GPU/utility, workers, and helper. Sample at 100 ms, with snapshots at scenario boundaries. Disclose the sampling limit.
- Quiet idle for 60 s: ≤500 MiB, CPU and repaint activity reported, no continuous animation.
- Peak ≤750 MiB across: five undelivered recovery entries, a five-minute capture, a retry, and a provider-worker and helper restart.
- Repeated sessions after clearing recovery, checked for retained growth.
- Never evict undelivered work to meet a limit.

Target-app and recovery protocol (#40) runs real `shortcut → capture → ASR → insertion` on the maintainer's M1 Pro, 16 GB, macOS 27. It covers the matrix in `tests/desktop/target-matrix.md`: TextEdit, Notes, Safari, Chrome, Slack, Google Docs, Notion, Outlook, VS Code, and Terminal. For each target it checks caret and selection insertion, a changed focus, a closed target, protected fields, and uncertain insertion. It also checks clipboard formats with a concurrent copy, and every entry point: shortcut, floating bar, menu bar, main window, and practice. The failure checks are Escape and clickable Cancel, offline capture with a replay after Stop, the 10/30-second deadlines from Stop and from Retry, key replace or remove during capture, a rejected key or exhausted quota, microphone loss or revoked permission, a helper or worker crash, full recovery, and the quit warning.

Limits on every run:

- Use only scratch documents, a scratch Slack channel or draft, and unsent drafts. Never send messages or email.
- In Terminal, dictate only where Return is never pressed. Never execute text.
- Capture only the dedicated scratch window. No whole-screen captures.
- Use no production storage and no private recordings.
- Record the app, OS, target app, and network versions.
