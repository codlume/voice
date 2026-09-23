// Pure acceptance logic: fixtures, manifests, guards, reports, and cost. No I/O beyond arguments.
import { createHash } from "node:crypto";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Stable JSON: sorted keys, so a manifest hash does not depend on construction order.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const hashOf = (value) => sha256(canonical(value));

// The PCM of a 16 kHz mono 16-bit WAV, matching the helper's FixtureWave rules.
export function wavPcm(buffer) {
  const tag = (offset) => buffer.toString("latin1", offset, offset + 4);
  if (buffer.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not-wav");
  let offset = 12;
  let format = false;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) throw new Error("truncated-wav");
    if (tag(offset) === "fmt ") {
      if (
        buffer.readUInt16LE(body) !== 1 ||
        buffer.readUInt16LE(body + 2) !== 1 ||
        buffer.readUInt32LE(body + 4) !== 16_000 ||
        buffer.readUInt16LE(body + 14) !== 16
      )
        throw new Error("wav-format");
      format = true;
    } else if (tag(offset) === "data") {
      if (!format || !size || size % 2 || size > 9_600_000) throw new Error("wav-data");
      return buffer.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("wav-data");
}
export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
// Seeded Gaussian noise: mulberry32 into Box-Muller, so held-out noise is reproducible.
export function noise(samples, seed, amplitude) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const out = new Float64Array(samples);
  for (let index = 0; index < samples; index++)
    out[index] =
      Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()) * amplitude;
  return out;
}
export function mix(pcm, added) {
  const out = Buffer.alloc(pcm.length);
  for (let index = 0; index < pcm.length / 2; index++)
    out.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(index * 2) + added[index]))),
      index * 2,
    );
  return out;
}
export function rms(pcm) {
  let sum = 0;
  for (let index = 0; index < pcm.length / 2; index++) sum += pcm.readInt16LE(index * 2) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}

export const classOf = (seconds) =>
  seconds <= 30 ? "short" : seconds < 300 ? "intermediate" : "five-minute";

// Nearest-rank percentile over successful samples only; undefined for an empty class.
export function nearestRank(values, percentile) {
  if (!values.length) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((percentile / 100) * sorted.length)) - 1];
}
export function median(values) {
  if (!values.length) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Word comparison ignoring case and punctuation. Quality is never auto-passed beyond this: any
// other difference is left for review, and the accepted identifier error is reported separately.
const words = (text) =>
  text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}' ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
export function quality(fixture, text) {
  const got = words(text ?? "");
  if (fixture.expected === "empty") return got.length ? "hallucination" : "empty";
  if (!got.length) return "missing-audio";
  const same = (reference) => words(reference).join(" ") === got.join(" ");
  if (same(fixture.spoken))
    return fixture.spoken === fixture.intended ? "match" : "deferred-formatting";
  const exception = fixture.knownException;
  if (exception && same(fixture.spoken.replace(exception.expected, exception.observed)))
    return "known-exception";
  return "review";
}

// Every slot the run may use, in the fixed order, per class. The seed rotates the start only.
export function runOrder(fixtures, stage) {
  const pool = fixtures.filter((fixture) => stage.fixtures.includes(fixture.id));
  if (!pool.length) throw new Error(`stage ${stage.name} has no fixtures`);
  const start = stage.seed % pool.length;
  return Array.from(
    { length: stage.maxAttempts },
    (_, index) => pool[(start + index) % pool.length].id,
  );
}

export function buildManifest({ plan, catalog, build, mode }) {
  const fixtures = catalog.fixtures;
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const stages = plan.stages.map((stage) => {
    for (const id of stage.fixtures ?? [])
      if (!byId.has(id)) throw new Error(`unknown fixture ${id}`);
    return { ...stage, order: stage.fixtures ? runOrder(fixtures, stage) : undefined };
  });
  const used = new Set(stages.flatMap((stage) => stage.order ?? []));
  return {
    kind: "voice-acceptance-manifest",
    version: 1,
    mode,
    build,
    provider: plan.provider,
    thresholds: plan.thresholds,
    conditions: plan.conditions,
    caps: mode === "live" ? plan.caps : plan.dryRunCaps,
    knownException: plan.knownException,
    stages,
    fixtures: fixtures
      .filter((fixture) => used.has(fixture.id))
      .map(({ id, sha256: hash, seconds, source, expected, spoken, intended, knownException }) => ({
        id,
        sha256: hash,
        seconds,
        class: classOf(seconds),
        source,
        expected,
        spoken,
        intended,
        knownException,
      })),
  };
}

// Live dispatch needs an explicit, matching authorization for this exact manifest and stage.
export function authorize(manifest, authorization, stageName) {
  const problems = [];
  if (manifest.mode !== "live") problems.push("manifest is not a live manifest");
  if (!authorization) return [...problems, "no authorization file"];
  if (authorization.manifestSha256 !== hashOf(manifest))
    problems.push("authorization does not match this manifest");
  if (!authorization.stages?.includes(stageName))
    problems.push(`authorization is not for stage ${stageName}`);
  if (authorization.approved !== true) problems.push("authorization is not approved");
  if (
    !/^https:\/\/github\.com\/codlume\/voice\/issues\/\d+#issuecomment-\d+$/.test(
      authorization.decision ?? "",
    )
  )
    problems.push("authorization does not link its recorded decision");
  for (const key of ["maxRequests", "maxAudioSeconds", "maxReplays"])
    if (!(authorization.caps?.[key] <= manifest.caps[key]))
      problems.push(`authorized ${key} exceeds or omits the manifest cap`);
  return problems;
}

// Before each dispatch: the worst case of this attempt, including its one allowed replay, must
// fit the remaining caps. Failures are never replaced beyond the stage's slots.
export function admit(ledger, caps, seconds) {
  const used = ledger.reduce(
    (total, entry) => ({
      requests: total.requests + (entry.requests ?? 0),
      audio: total.audio + (entry.submittedSeconds ?? 0),
      replays: total.replays + (entry.replays ?? 0),
    }),
    { requests: 0, audio: 0, replays: 0 },
  );
  const replay = used.replays < caps.maxReplays ? 1 : 0;
  if (used.requests + 1 + replay > caps.maxRequests) return { ok: false, reason: "request cap" };
  if (used.audio + seconds * (1 + replay) > caps.maxAudioSeconds)
    return { ok: false, reason: "audio cap" };
  return { ok: true, used };
}

// A normal-path latency sample: one provider request, confirmed insertion, verified target.
export const normalSuccess = (entry) =>
  entry.outcome === "inserted" && entry.replays === 0 && entry.targetVerified === true;

export function summarize(manifest, ledger) {
  const thresholds = manifest.thresholds;
  const classes = {};
  for (const stage of manifest.stages) {
    const entries = ledger.filter((entry) => entry.stage === stage.name);
    const successes = entries.filter((entry) =>
      stage.kind === "normal" ? normalSuccess(entry) : entry.outcome === "measured",
    );
    const metric =
      stage.kind === "normal"
        ? "stopToInsertionMs"
        : stage.kind === "cold-launch"
          ? "launchToReadyMs"
          : stage.kind === "warm-start"
            ? "shortcutToFirstFrameMs"
            : undefined;
    const values = metric ? successes.map((entry) => entry[metric]) : [];
    const threshold = thresholds[stage.threshold] ?? {};
    const p95 = nearestRank(values, 95);
    const mid = median(values);
    classes[stage.name] = {
      kind: stage.kind,
      metric,
      attempts: entries.length,
      successes: successes.length,
      required: stage.successes,
      complete: successes.length >= (stage.successes ?? 0),
      medianMs: mid,
      p95Ms: p95,
      threshold,
      meets:
        metric && successes.length >= (stage.successes ?? 0)
          ? (threshold.p95Ms === undefined || p95 <= threshold.p95Ms) &&
            (threshold.medianMs === undefined || mid <= threshold.medianMs)
          : undefined,
      failures: entries
        .filter((entry) => !successes.includes(entry))
        .map(({ slot, fixture, outcome, reason, replays }) => ({
          slot,
          fixture,
          outcome,
          reason,
          replays,
        })),
      stoppedBy: entries.at(-1)?.stoppedBy,
    };
  }
  const outcomes = {};
  for (const entry of ledger.filter((item) => item.quality))
    (outcomes[entry.quality] ??= []).push({
      stage: entry.stage,
      slot: entry.slot,
      fixture: entry.fixture,
    });
  const models = [...new Set(ledger.flatMap((entry) => entry.models ?? []))];
  return {
    manifestSha256: hashOf(manifest),
    mode: manifest.mode,
    classes,
    quality: outcomes,
    knownException: outcomes["known-exception"] ?? [],
    reviewNeeded: outcomes.review ?? [],
    models,
    totals: {
      attempts: ledger.length,
      requests: ledger.reduce((sum, entry) => sum + (entry.requests ?? 0), 0),
      submittedSeconds: ledger.reduce((sum, entry) => sum + (entry.submittedSeconds ?? 0), 0),
      replays: ledger.reduce((sum, entry) => sum + (entry.replays ?? 0), 0),
    },
  };
}

// Reservation at the regular rate with the tax allowance, rounded up per request to a micro-dollar.
export function cost(plan, requests) {
  const perRequest = (seconds, rate) =>
    Math.ceil((seconds / 60) * rate * (1 + plan.cost.taxAllowance) * 1e6) / 1e6;
  const sum = (rate) => requests.reduce((total, seconds) => total + perRequest(seconds, rate), 0);
  const reservation = Math.round(sum(plan.cost.regularRate) * 1e6) / 1e6;
  const available = Math.round((plan.cost.workingAllowance - plan.cost.heldAllocation) * 1e6) / 1e6;
  return {
    requests: requests.length,
    audioSeconds: requests.reduce((a, b) => a + b, 0),
    promotionalBeforeTax:
      Math.round(requests.reduce((t, s) => t + (s / 60) * plan.cost.promotionalRate, 0) * 1e6) /
      1e6,
    regularBeforeTax:
      Math.round(requests.reduce((t, s) => t + (s / 60) * plan.cost.regularRate, 0) * 1e6) / 1e6,
    reservation,
    available,
    shortfall: Math.max(0, Math.round((reservation - available) * 1e6) / 1e6),
  };
}
// The worst-case billable requests the live caps permit: every slot plus every allowed replay.
export function worstCase(manifest) {
  const seconds = new Map(manifest.fixtures.map((fixture) => [fixture.id, fixture.seconds]));
  const requests = manifest.stages
    .filter((stage) => stage.provider !== "loopback")
    .flatMap((stage) => (stage.order ?? []).map((id) => seconds.get(id)));
  const longest = requests.toSorted((a, b) => b - a).slice(0, manifest.caps.maxReplays);
  const all = [...requests, ...longest];
  let audio = 0;
  const capped = [];
  for (const value of all) {
    if (capped.length >= manifest.caps.maxRequests || audio + value > manifest.caps.maxAudioSeconds)
      break;
    capped.push(value);
    audio += value;
  }
  return capped;
}

// Resource run summary. Each sample sums the physical footprint of every process in main's tree
// at that instant; a process that starts and exits between two samples is never observed.
const mib = (bytes) => bytes / 2 ** 20;
export function summarizeResources({ samples, events, thresholds, intervalMs }) {
  const total = (sample) => mib(sample.processes.reduce((sum, item) => sum + item.footprint, 0));
  const phases = {};
  for (const sample of samples) (phases[sample.phase] ??= []).push(sample);
  const summary = Object.fromEntries(
    Object.entries(phases).map(([name, list]) => {
      const totals = list.map(total);
      const gaps = list.slice(1).map((sample, index) => sample.at - list[index].at);
      const peak = list[totals.indexOf(Math.max(...totals))];
      return [
        name,
        {
          samples: list.length,
          peakMiB: Math.max(...totals),
          meanMiB: totals.reduce((sum, value) => sum + value, 0) / totals.length,
          lastMiB: totals.at(-1),
          maxGapMs: gaps.length ? Math.max(...gaps) : undefined,
          processes: list.at(-1).processes.length,
          atPeak: peak.processes.map(({ pid, name, footprint }) => ({
            pid,
            name,
            MiB: mib(footprint),
          })),
        },
      ];
    }),
  );
  // CPU across an idle phase, in percent of one core, from processes present at both ends.
  const cpu = (name) => {
    const list = phases[name];
    if (!list || list.length < 2) return undefined;
    const [first, last] = [list[0], list.at(-1)];
    const seconds = (last.at - first.at) / 1000;
    const perProcess = last.processes.flatMap((item) => {
      const start = first.processes.find((entry) => entry.pid === item.pid);
      return start
        ? [{ name: item.name, percent: (item.cpuNs - start.cpuNs) / 1e7 / seconds }]
        : [];
    });
    return {
      seconds,
      percent: perProcess.reduce((sum, item) => sum + item.percent, 0),
      perProcess,
    };
  };
  const event = (name) => events.find((entry) => entry.phase === name);
  const paint = (name) => {
    const [start, end] = [event(name)?.paint, event(`${name}.end`)?.paint];
    if (!start || !end) return undefined;
    return end.map((window) => {
      const before = start.find((entry) => entry.url === window.url) ?? {};
      return {
        url: window.url,
        visible: window.visible,
        animations: window.animations,
        layouts: window.layouts - (before.layouts ?? 0),
        styles: window.styles - (before.styles ?? 0),
        taskMs: window.taskMs - (before.taskMs ?? 0),
      };
    });
  };
  const idleNames = ["idle", "idle-after"].filter((name) => summary[name]);
  const idlePeak = Math.max(...idleNames.map((name) => summary[name].peakMiB));
  const peak = Math.max(...Object.values(summary).map((item) => item.peakMiB));
  const held = ["backlog.full", "retry.end", "worker-restart.end"].map((name) => ({
    phase: name,
    recovery: event(name)?.recovery,
  }));
  const maxGapMs = Math.max(...Object.values(summary).map((item) => item.maxGapMs ?? 0));
  return {
    intervalMs,
    maxGapMs,
    phases: summary,
    idle: {
      peakMiB: idlePeak,
      meets: idlePeak <= thresholds.idleMiB,
      cpu: Object.fromEntries(idleNames.map((name) => [name, cpu(name)])),
      paint: Object.fromEntries(idleNames.map((name) => [name, paint(name)])),
    },
    peak: { peakMiB: peak, meets: peak <= thresholds.peakMiB },
    // Recovery must stay full through Retry and subordinate restarts: no eviction to fit a budget.
    backlogHeld: { phases: held, meets: held.every((item) => item.recovery === 5) },
    growth:
      summary.idle && summary["idle-after"]
        ? {
            meanMiB: summary["idle-after"].meanMiB - summary.idle.meanMiB,
            processes: summary["idle-after"].processes - summary.idle.processes,
          }
        : undefined,
  };
}
