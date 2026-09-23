#!/usr/bin/env node
// Acceptance runner. Usage:
//   recover                                   verify and extract every frozen fixture
//   manifest --mode dry-run|live [--stages a,b] [--successes n] [--max-attempts n]
//   cost --manifest <file>                    worst-case requests and reservation for live caps
//   run --manifest <file> [--target textedit|recovery] [--authorization <file>] [--network <text>]
//   verify --run <dir>                        recheck hashes and recompute the report offline
//   report --run <dir>                        report an interrupted run from its ledger
//   resources                                 whole-app memory, idle CPU, and repaint run (loopback)
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createInterface } from "node:readline";
// Node strips the types; the manifest binds the exact URL the adapter uses.
import { deepgramUrl } from "../../packages/providers/src/asr.ts";
import {
  admit,
  authorize,
  buildManifest,
  cost,
  hashOf,
  quality,
  sha256,
  summarize,
  summarizeResources,
  worstCase,
} from "./lib.mjs";
import { intervalMs, resources } from "./resources.mjs";
import { fixturePath, loadCatalog, recover, root, verify, work } from "./fixtures.mjs";
import {
  dictate,
  executable,
  launch,
  loopback,
  noTarget,
  osVersion,
  textEdit,
  warmStart,
} from "./session.mjs";

const exec = promisify(execFile);
const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string" },
    stages: { type: "string" },
    successes: { type: "string" },
    "max-attempts": { type: "string" },
    manifest: { type: "string" },
    authorization: { type: "string" },
    target: { type: "string", default: "recovery" },
    network: { type: "string" },
    run: { type: "string" },
  },
});
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");

async function build() {
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  const app = join(executable, "../../Resources/app.asar");
  const helper = join(executable, "../../Resources/app.asar.unpacked/native/voice-helper");
  if (!existsSync(app) || !existsSync(helper)) throw new Error("Run pnpm package:desktop first");
  return {
    commit: await git("rev-parse", "HEAD"),
    dirty: (await git("status", "--porcelain")).length > 0,
    appAsarSha256: sha256(await readFile(app)),
    helperSha256: sha256(await readFile(helper)),
    deepgramUrl,
  };
}

async function manifestCommand() {
  const mode = options.mode;
  if (mode !== "dry-run" && mode !== "live") throw new Error("--mode dry-run|live");
  const plan = await readJson(join(root, "tests/acceptance/plan.json"));
  const catalog = await loadCatalog();
  if (mode === "live" && (options.stages || options.successes || options["max-attempts"]))
    throw new Error(
      "A live manifest uses the frozen plan; revise plan.json through a recorded decision.",
    );
  const wanted = options.stages?.split(",");
  const stages = plan.stages
    .filter((stage) => !wanted || wanted.includes(stage.name))
    .map((stage) => ({
      ...stage,
      ...(options.successes
        ? { successes: Math.min(stage.successes, Number(options.successes)) }
        : {}),
      ...(options["max-attempts"] ? { maxAttempts: Number(options["max-attempts"]) } : {}),
    }));
  const manifest = buildManifest({
    plan: { ...plan, stages },
    catalog,
    build: await build(),
    mode,
  });
  await verify(
    catalog,
    manifest.fixtures.map((fixture) => fixture.id),
  );
  if (mode === "live" && manifest.build.dirty)
    throw new Error("A live manifest needs a clean, committed build.");
  await mkdir(join(work, "manifests"), { recursive: true });
  const file = join(work, "manifests", `${mode}-${hashOf(manifest).slice(0, 12)}.json`);
  await writeJson(file, manifest);
  console.log(file);
  console.log(`manifest sha256 ${hashOf(manifest)}`);
}

async function costCommand() {
  const manifest = await readJson(options.manifest);
  const plan = await readJson(join(root, "tests/acceptance/plan.json"));
  console.log(JSON.stringify(cost(plan, worstCase(manifest)), null, 2));
}

// Hidden key entry for live mode. The key goes only into the isolated test Keychain.
async function hiddenKey() {
  if (!process.stdin.isTTY) throw new Error("Live mode needs an interactive terminal for the key.");
  process.stdout.write("Deepgram key (hidden): ");
  await exec("stty", ["-echo"], { stdio: "inherit" }).catch(() => {});
  const lines = createInterface({ input: process.stdin });
  const [key] = await once(lines, "line");
  lines.close();
  await exec("stty", ["echo"]).catch(() => {});
  process.stdout.write("\n");
  return key.trim();
}
// Dry-run provider text: the spoken reference, with the recorded identifier error kept in, so
// the report's known-exception path is exercised without a paid call.
const scripted = (fixture) =>
  fixture.knownException
    ? fixture.spoken.replace(fixture.knownException.expected, fixture.knownException.observed)
    : fixture.spoken;
async function runCommand() {
  const manifest = await readJson(options.manifest);
  const live = manifest.mode === "live";
  const current = await build();
  // The runner refuses a manifest built for another commit or package.
  for (const key of ["commit", "appAsarSha256", "helperSha256", "deepgramUrl"])
    if (current[key] !== manifest.build[key])
      throw new Error(`build ${key} differs from the manifest`);
  const catalog = await loadCatalog();
  await verify(
    catalog,
    manifest.fixtures.map((fixture) => fixture.id),
  );
  for (const fixture of manifest.fixtures)
    if (catalog.fixtures.find((item) => item.id === fixture.id)?.sha256 !== fixture.sha256)
      throw new Error(`${fixture.id} changed since the manifest`);
  const paid = manifest.stages.filter((stage) => stage.provider === "deepgram");
  if (live) {
    const authorization = options.authorization ? await readJson(options.authorization) : undefined;
    const problems = paid.flatMap((stage) =>
      authorize(manifest, authorization, stage.name).map((p) => `${stage.name}: ${p}`),
    );
    if (problems.length) throw new Error(`Live dispatch refused:\n${problems.join("\n")}`);
    if (!options.network)
      throw new Error("Live mode needs --network describing the declared network condition.");
  }
  const directory = join(
    work,
    "runs",
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${manifest.mode}`,
  );
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "manifest.json"), manifest);
  await writeJson(join(directory, "run.json"), {
    manifestSha256: hashOf(manifest),
    environment: await osVersion(),
    target: options.target,
    network: options.network ?? "dry run: loopback provider",
    input: "virtual synthetic capture; no physical microphone",
    shortcut: "test hook into main's shortcut handler; no native key tap",
    startedAt: new Date().toISOString(),
    liveEstablished: false,
  });
  const ledgerFile = join(directory, "ledger.jsonl");
  const ledger = [];
  // Every attempt is appended before the next one starts, including refusals and failures.
  const record = async (entry) => {
    ledger.push(entry);
    await appendFile(ledgerFile, JSON.stringify(entry) + "\n");
  };
  const server = await loopback();
  const byId = new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture]));
  const target = options.target === "textedit" ? await textEdit() : noTarget;
  const data = await mkdtemp(join(tmpdir(), "voice-acceptance-"));
  const deadline = (fixture) =>
    fixture.seconds <= 30
      ? manifest.thresholds.deadline.shortMs
      : manifest.thresholds.deadline.longMs;
  let voice;
  const open = async (provider) => {
    voice = await launch({ provider, directory: data });
    return voice;
  };
  try {
    for (const stage of manifest.stages) {
      const provider = stage.provider === "deepgram" && live ? "live" : server.url;
      if (stage.kind === "cold-launch") {
        for (
          let slot = 0;
          slot < stage.maxAttempts &&
          ledger.filter((e) => e.stage === stage.name && e.outcome === "measured").length <
            stage.successes;
          slot++
        ) {
          await voice?.app.close();
          voice = undefined;
          const launched = await open(server.url);
          await record({
            stage: stage.name,
            slot,
            outcome: "measured",
            launchToReadyMs: launched.launchToReadyMs,
            requests: 0,
            replays: 0,
          });
        }
        continue;
      }
      if (voice?.provider !== provider) {
        await voice?.app.close();
        await open(provider);
        voice.provider = provider;
        if (provider === "live")
          await voice.command({ type: "credential.set", key: await hiddenKey() });
      }
      if (stage.kind === "warm-start") {
        for (
          let slot = 0;
          slot < stage.maxAttempts &&
          ledger.filter((e) => e.stage === stage.name && e.outcome === "measured").length <
            stage.successes;
          slot++
        )
          await record({ stage: stage.name, slot, ...(await warmStart(voice, target)) });
        continue;
      }
      if (stage.kind === "faults") {
        await runFaults(stage, voice, target, server, byId, record);
        continue;
      }
      for (const [slot, id] of stage.order.entries()) {
        const successes = ledger.filter(
          (entry) =>
            entry.stage === stage.name &&
            entry.outcome === (stage.kind === "normal" ? "inserted" : "measured") &&
            (stage.kind !== "normal" || (entry.replays === 0 && entry.targetVerified)),
        );
        if (stage.kind === "normal" && successes.length >= stage.successes) break;
        const fixture = byId.get(id);
        const admitted = admit(ledger, manifest.caps, fixture.seconds);
        if (!admitted.ok) {
          await record({
            stage: stage.name,
            slot,
            fixture: id,
            outcome: "not-dispatched",
            reason: admitted.reason,
            stoppedBy: admitted.reason,
            requests: 0,
            replays: 0,
          });
          break;
        }
        server.set(scripted(fixture));
        const result = await dictate(voice, target, fixture, {
          path: fixturePath(fixture),
          deadlineMs: deadline(fixture),
        });
        const judged = quality(fixture, result.text);
        await record({
          stage: stage.name,
          slot,
          fixture: id,
          ...result,
          outcome:
            stage.kind === "quality" ? (judged === "empty" ? "measured" : judged) : result.outcome,
          submittedSeconds: provider === "live" ? result.requests * fixture.seconds : 0,
          quality: judged,
        });
      }
    }
  } finally {
    await voice?.command({ type: "credential.remove" }).catch(() => {});
    await voice?.app.close().catch(() => {});
    await server.close();
    await target.close();
    await rm(data, { recursive: true, force: true });
  }
  await finish(directory, manifest, ledger);
  console.log(directory);
}

// Deterministic loopback faults. Each passes only as its recoverable outcome; none is a latency sample.
async function runFaults(stage, voice, target, server, byId, record) {
  const short =
    byId.get("request") ??
    [...byId.values()].find((fixture) => fixture.seconds <= 10 && fixture.expected === "text");
  const silence =
    byId.get("negative_silence") ??
    [...byId.values()].find((fixture) => fixture.expected === "empty");
  const cases = {
    "transient-drop-replays-once": {
      fixture: short,
      mode: "drop-first",
      expect: (r) => r.requests === 2 && r.text === short.spoken,
    },
    "deadline-expires-recoverable": {
      fixture: short,
      mode: "hold",
      expect: (r) => r.outcome === "recovery-incomplete" && r.stopToSettledMs <= 10_000 + 1_000,
    },
    "rejected-key-stops": {
      fixture: short,
      mode: "reject",
      expect: (r) => r.outcome === "recovery-incomplete" && r.providerFailures.includes("rejected"),
    },
    "cancel-discards": {
      fixture: short,
      mode: "echo",
      cancel: true,
      expect: (r) => r.phase === "cancelled" && !r.marks.some((m) => m.mark === "insertion"),
    },
    "silence-inserts-nothing": {
      fixture: silence,
      mode: "echo",
      expect: (r) => !r.marks.some((m) => m.mark === "insertion") && !r.text,
    },
  };
  for (const [slot, name] of stage.scenarios.entries()) {
    const scenario = cases[name];
    if (!scenario?.fixture) {
      await record({
        stage: stage.name,
        slot,
        scenario: name,
        outcome: "missing-fixture",
        requests: 0,
        replays: 0,
      });
      continue;
    }
    server.set(scenario.fixture.expected === "empty" ? "" : scenario.fixture.spoken, scenario.mode);
    const result = await dictate(voice, target, scenario.fixture, {
      path: fixturePath(scenario.fixture),
      deadlineMs: 10_000,
      cancel: scenario.cancel,
    });
    server.set("", "echo");
    await record({
      stage: stage.name,
      slot,
      scenario: name,
      fixture: scenario.fixture.id,
      ...result,
      observed: result.outcome,
      outcome: scenario.expect(result) ? "measured" : "unexpected",
      simulated: true,
    });
  }
}

async function finish(directory, manifest, ledger, interrupted = false) {
  const report = summarize(manifest, ledger);
  await writeJson(join(directory, "report.json"), report);
  await writeFile(join(directory, "REPORT.md"), markdown(manifest, report, interrupted));
  await checksum(directory);
}

const ms = (value) => (value === undefined ? "–" : `${Math.round(value)} ms`);
function markdown(manifest, report, interrupted) {
  const rows = Object.entries(report.classes).map(
    ([name, item]) =>
      `| ${name} | ${item.metric ?? "outcome"} | ${item.attempts} | ${item.successes}/${item.required ?? 0} | ${ms(item.medianMs)} | ${ms(item.p95Ms)} | ${item.threshold.medianMs ? `median ≤${item.threshold.medianMs}, ` : ""}${item.threshold.p95Ms ? `p95 ≤${item.threshold.p95Ms}` : "–"} | ${item.meets === undefined ? "not established" : item.meets ? "meets" : "fails"} |`,
  );
  const failures = Object.entries(report.classes).flatMap(([name, item]) =>
    item.failures.map(
      (failure) =>
        `- ${name} slot ${failure.slot} ${failure.fixture ?? ""}: ${failure.outcome}${failure.reason ? ` (${failure.reason})` : ""}${failure.replays ? `, ${failure.replays} replay` : ""}`,
    ),
  );
  return `# Voice acceptance ${manifest.mode}

Manifest \`${report.manifestSha256}\`, commit \`${manifest.build.commit}\`${manifest.build.dirty ? " (uncommitted changes)" : ""}.

${interrupted ? "**Interrupted before every stage ran. Stages without attempts are absent, and a stage with too few successes is not established.**\n\n" : ""}${manifest.mode === "live" ? "Live Deepgram run." : "**Dry run against a loopback provider. It establishes no live quality, insertion timing, or whole-app acceptance.**"} Input is virtual synthetic capture, not a physical microphone. Shortcuts use main's test hook, not a native key tap.

| Stage | Metric | Attempts | Successes | Median | p95 (nearest rank) | Accepted | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
${rows.join("\n")}

Percentiles use successful normal-path samples only: one provider request, confirmed insertion, and target readback. Replays, recovery, and fault outcomes are never latency samples. Small-sample percentiles are observations, not reliability guarantees.

## Every failed or incomplete attempt

${failures.length ? failures.join("\n") : "None."}

## Quality

- Known exception (\`${manifest.knownException.expected}\` → \`${manifest.knownException.observed}\`), reported as a failure: ${report.knownException.map((item) => `${item.stage}#${item.slot}`).join(", ") || "not observed"}.
- Needs review: ${report.reviewNeeded.map((item) => `${item.fixture} (${item.stage}#${item.slot})`).join(", ") || "none"}.
- Outcomes: ${
    Object.entries(report.quality)
      .map(([kind, items]) => `${kind} ${items.length}`)
      .join(", ") || "none"
  }.
- Returned model UUIDs: ${report.models.join(", ") || "none"}.

Totals: ${report.totals.attempts} attempts, ${report.totals.requests} provider requests, ${report.totals.replays} replays, ${report.totals.submittedSeconds} billable seconds submitted.
`;
}

async function verifyCommand() {
  const directory = options.run;
  const listed = (await readFile(join(directory, "ARTIFACTS.sha256"), "utf8")).trim().split("\n");
  for (const line of listed) {
    const [hash, name] = line.split(/\s+/);
    if (sha256(await readFile(join(directory, name))) !== hash) throw new Error(`${name} changed`);
  }
  const manifest = await readJson(join(directory, "manifest.json"));
  const ledger = (await readFile(join(directory, "ledger.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const report = await readJson(join(directory, "report.json"));
  if (JSON.stringify(summarize(manifest, ledger)) !== JSON.stringify(report))
    throw new Error("report does not follow from the ledger");
  const run = await readJson(join(directory, "run.json"));
  if (run.manifestSha256 !== hashOf(manifest)) throw new Error("run record names another manifest");
  if (/Token |dg_[A-Za-z0-9]/.test(await readFile(join(directory, "ledger.jsonl"), "utf8")))
    throw new Error("credential-like text in evidence");
  console.log(
    `${relative(root, directory)}: ${listed.length} artifacts, ${ledger.length} attempts verified`,
  );
}

// Resource runs need no provider spend: the loopback stand-in answers every request.
async function resourcesCommand() {
  const plan = await readJson(join(root, "tests/acceptance/plan.json"));
  const directory = join(
    work,
    "runs",
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-resources`,
  );
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "run.json"), {
    kind: "resources",
    build: await build(),
    environment: await osVersion(),
    provider: "loopback stand-in; no Deepgram requests",
    input: "virtual synthetic capture; no physical microphone",
    sampling: `proc_pid_rusage phys_footprint of main's process tree every ${intervalMs} ms`,
    startedAt: new Date().toISOString(),
  });
  const events = await resources({ directory });
  const samples = (await readFile(join(directory, "samples.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const report = summarizeResources({
    samples,
    events,
    thresholds: plan.thresholds.memory,
    intervalMs,
  });
  await writeJson(join(directory, "report.json"), report);
  await writeFile(join(directory, "REPORT.md"), resourcesMarkdown(report, plan.thresholds.memory));
  await checksum(directory);
  console.log(directory);
}

const mb = (value) => (value === undefined ? "–" : `${value.toFixed(1)} MiB`);
function resourcesMarkdown(report, thresholds) {
  const verdict = (meets) => (meets ? "meets" : "fails");
  const phases = Object.entries(report.phases).map(
    ([name, item]) =>
      `| ${name} | ${item.samples} | ${mb(item.meanMiB)} | ${mb(item.peakMiB)} | ${item.processes} | ${item.maxGapMs ?? "–"} ms |`,
  );
  const cpu = Object.entries(report.idle.cpu).map(
    ([name, item]) =>
      `- ${name}: ${item.percent.toFixed(2)}% of one core over ${item.seconds.toFixed(0)} s (${item.perProcess
        .map((process) => `${process.name} ${process.percent.toFixed(2)}%`)
        .join(", ")})`,
  );
  const paint = Object.entries(report.idle.paint).flatMap(([name, windows]) =>
    (windows ?? []).map(
      (window) =>
        `- ${name} ${window.url || "/"} (${window.visible}): ${window.layouts} layouts, ${window.styles} style recalcs, ${window.taskMs.toFixed(1)} ms main-thread tasks, ${window.animations} running animations`,
    ),
  );
  return `# Voice resource run

Loopback provider, virtual synthetic capture, packaged build. Each sample sums the OS physical footprint (\`proc_pid_rusage\` \`phys_footprint\`) of every process in main's tree: main, renderers, GPU and utility processes, provider and storage workers, and the helper.

| Budget | Measured | Accepted | Result |
| --- | ---: | ---: | --- |
| Idle, all processes | ${mb(report.idle.peakMiB)} peak | ≤${thresholds.idleMiB} MiB | ${verdict(report.idle.meets)} |
| Peak, every scenario | ${mb(report.peak.peakMiB)} | ≤${thresholds.peakMiB} MiB | ${verdict(report.peak.meets)} |
| Backlog held through Retry and restarts | ${report.backlogHeld.phases.map((item) => `${item.phase} ${item.recovery ?? "?"}`).join(", ")} | 5 entries | ${verdict(report.backlogHeld.meets)} |

| Phase | Samples | Mean | Peak | Processes | Largest gap |
| --- | ---: | ---: | ---: | ---: | ---: |
${phases.join("\n")}

## Quiet idle

${cpu.join("\n")}

${paint.join("\n")}

Growth from the first idle to idle after recovery release and 20 repeated sessions: ${mb(report.growth?.meanMiB)} mean, ${report.growth?.processes ?? "?"} processes.

## Sampling limits

Samples are ${report.intervalMs} ms apart; the largest observed gap was ${report.maxGapMs} ms. A spike shorter than one gap, or a process that starts and exits between samples, is not observed. Footprint is read from outside each process, so it includes memory the process has freed but the allocator still holds. The sampler itself is not part of the tree.
`;
}

async function checksum(directory) {
  const files = (await readdir(directory)).filter((name) => name !== "ARTIFACTS.sha256").toSorted();
  const lines = [];
  for (const name of files) lines.push(`${sha256(await readFile(join(directory, name)))}  ${name}`);
  await writeFile(join(directory, "ARTIFACTS.sha256"), lines.join("\n") + "\n");
}

// An interrupted run keeps every attempt already appended to its ledger; report exactly those.
async function reportCommand() {
  const directory = options.run;
  if (existsSync(join(directory, "ARTIFACTS.sha256"))) throw new Error("run is already reported");
  const manifest = await readJson(join(directory, "manifest.json"));
  const ledger = (await readFile(join(directory, "ledger.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  await finish(directory, manifest, ledger, true);
  console.log(directory);
}

const commands = {
  recover: async () => console.log(`${await recover()} fixtures verified`),
  manifest: manifestCommand,
  cost: costCommand,
  run: runCommand,
  verify: verifyCommand,
  report: reportCommand,
  resources: resourcesCommand,
};
const command = commands[positionals[0]];
if (!command) {
  console.error("usage: cli.mjs recover|manifest|cost|run|verify|report|resources");
  process.exit(2);
}
await command();
