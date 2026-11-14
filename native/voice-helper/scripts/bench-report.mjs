// The parts of bench.mjs that touch nothing outside their arguments: argument parsing, the
// statistics, the parsers for what the helper and the system tools print, and the report's shape.
import { parseArgs as parseFlags } from "node:util";

export const USAGE =
  "usage: node native/voice-helper/scripts/bench.mjs --candidate <voice-helper> [--baseline <voice-helper>] [--runs N] [--only a,b] [--out file.json] [--fnpost <fnpost>] [--verbose]";
export const METRICS = [
  "load-warm",
  "launch",
  "load-cold",
  "finalization",
  "hotkey",
  "mic-start",
  "paste",
  "footprint",
];
export const VERDICT_RULE =
  "A side is called lower or higher only when the two sides' sample ranges do not overlap and that would happen by chance in under 5% of runs of one binary against itself (falsePositiveRate). noiseFloor is the larger of the two sides' ranges (max - min).";

export const round = (value) => Math.round(value * 1000) / 1000;

export function parseArgs(argv) {
  const { values } = parseFlags({
    args: argv,
    options: {
      baseline: { type: "string" },
      candidate: { type: "string" },
      runs: { type: "string" },
      only: { type: "string" },
      out: { type: "string" },
      fnpost: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.candidate) throw new Error("--candidate <voice-helper binary> is required");
  let runs = null;
  if (values.runs !== undefined) {
    runs = Number(values.runs);
    if (!Number.isInteger(runs) || runs < 1) {
      throw new Error(`--runs must be a positive integer, got ${values.runs}`);
    }
  }
  const only = values.only?.split(",").filter(Boolean);
  const unknown = only?.filter((name) => !METRICS.includes(name)) ?? [];
  if (unknown.length > 0) {
    throw new Error(`--only names no metric: ${unknown.join(", ")} (known: ${METRICS.join(", ")})`);
  }
  if (only?.length === 0) throw new Error("--only needs at least one metric");
  return {
    baseline: values.baseline ?? null,
    candidate: values.candidate,
    runs,
    metrics: only ? METRICS.filter((name) => only.includes(name)) : METRICS,
    out: values.out ?? null,
    fnpost: values.fnpost ?? null,
    verbose: values.verbose,
  };
}

/** `samples[run]` is null where that run failed; the statistics cover the rest. */
export function summarize(samples) {
  const values = samples.filter((value) => value !== null).toSorted((a, b) => a - b);
  if (values.length === 0) {
    return { samples, n: 0, median: null, min: null, max: null, range: null };
  }
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const [min, max] = [values[0], values.at(-1)];
  return { samples, n: values.length, median: round(median), min, max, range: round(max - min) };
}

// How often two samples of one distribution have disjoint ranges, either way round:
// 2 * n! * m! / (n + m)!.
function disjointByChance(n, m) {
  let rate = 2;
  for (let i = 1; i <= m; i += 1) rate *= i / (n + i);
  return rate;
}

export function compare(baseline, candidate) {
  if (baseline.n === 0 || candidate.n === 0) return { verdict: "no samples on one side" };
  const pairedDeltas = baseline.samples.map((value, run) => {
    const other = candidate.samples[run] ?? null;
    return value === null || other === null ? null : round(other - value);
  });
  const deltas = pairedDeltas.filter((delta) => delta !== null);
  const medianDelta = round(candidate.median - baseline.median);
  const falsePositiveRate = round(disjointByChance(baseline.n, candidate.n));
  let verdict = "no measurable difference";
  if (candidate.max < baseline.min || candidate.min > baseline.max) {
    const direction = candidate.max < baseline.min ? "lower" : "higher";
    verdict =
      falsePositiveRate < 0.05
        ? `candidate ${direction}`
        : `candidate ${direction} in every sample, but too few samples to call`;
  }
  return {
    medianDelta,
    medianDeltaPercent: baseline.median === 0 ? null : round((100 * medianDelta) / baseline.median),
    noiseFloor: Math.max(baseline.range, candidate.range),
    falsePositiveRate,
    pairedDeltas,
    candidateLowerInPairs: `${deltas.filter((delta) => delta < 0).length} of ${deltas.length}`,
    verdict,
  };
}

/** `samplesBySide` is `{ baseline?: (number | null)[], candidate: (number | null)[] }`. */
export function measurement({ unit, source, ...rest }, samplesBySide) {
  const sides = Object.fromEntries(
    Object.entries(samplesBySide).map(([side, samples]) => [side, summarize(samples)]),
  );
  return {
    unit,
    source,
    ...rest,
    sides,
    ...(sides.baseline && sides.candidate
      ? { comparison: compare(sides.baseline, sides.candidate) }
      : {}),
  };
}

export function missingAnchors(text, words) {
  return words.filter((word) => !text.toLowerCase().includes(word.toLowerCase()));
}

/** A run passes only when both sides produced a transcript and the two are the same string. */
export function compareTranscripts(baseline, candidate) {
  const differences = [];
  for (let run = 0; run < Math.max(baseline.length, candidate.length); run += 1) {
    const texts = { baseline: baseline[run] ?? null, candidate: candidate[run] ?? null };
    if (texts.baseline === null || texts.baseline !== texts.candidate) {
      differences.push({ run, ...texts });
    }
  }
  return { matchesBaseline: differences.length === 0, differences };
}

/** The helper logs which way a session's text was produced; no line means a full decode. */
export function finalizationPath(logMessages) {
  const logged = (start) => logMessages.some((message) => message.startsWith(start));
  if (logged("streaming ASR finalized ")) return "streamed";
  if (logged("ASR reused the decode from the last pause")) return "reused pause decode";
  if (logged("streaming ASR incomplete")) return "full decode after an incomplete stream";
  if (logged("ASR decode from the last pause failed")) {
    return "full decode after a failed pause decode";
  }
  return "full decode";
}

export function parseIntegrityLog(message) {
  const match =
    /^speech model checked: first pass hashed (\d+) files, (\d+) bytes, done in (\d+) ms$/.exec(
      message,
    );
  return match
    ? { hashedFiles: Number(match[1]), hashedBytes: Number(match[2]), ms: Number(match[3]) }
    : null;
}

/** The tail `/usr/bin/time -l` writes when its child exits; decimals follow the locale. */
export function parseTimeOutput(text) {
  const number = (pattern) => {
    const match = pattern.exec(text);
    if (!match)
      throw new Error(`/usr/bin/time -l output lacks ${pattern}: ${JSON.stringify(text)}`);
    return Number(match[1].replace(",", "."));
  };
  return {
    realS: number(/([\d.,]+) real/),
    userS: number(/([\d.,]+) user/),
    sysS: number(/([\d.,]+) sys/),
    maxRssBytes: number(/(\d+)\s+maximum resident set size/),
    peakFootprintBytes: number(/(\d+)\s+peak memory footprint/),
  };
}

/** ps prints cumulative CPU time as [[dd-]hh:]mm:ss.cc. */
export function cpuSeconds(time) {
  const [rest, days = "0"] = time.split("-").toReversed();
  return (
    Number(days) * 86_400 +
    rest.split(":").reduce((total, part) => total * 60 + Number(part.replace(",", ".")), 0)
  );
}

/** A size as `top` prints it, such as 2304K, 58M or 1.2G, in MiB. */
export function topMemoryMb(text) {
  const match = /^([\d.]+)([BKMG])[+-]?$/.exec(text.trim());
  if (!match) throw new Error(`top printed a size this cannot read: ${JSON.stringify(text)}`);
  return Number(match[1]) * { B: 1 / 1024 ** 2, K: 1 / 1024, M: 1, G: 1024 }[match[2]];
}

export function wavDurationMs(buffer) {
  if (buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF WAVE file");
  }
  let byteRate = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString("latin1", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buffer.readUInt32LE(offset + 16);
    if (id === "data") {
      if (!byteRate) throw new Error("WAVE data chunk came before its fmt chunk");
      return round((Math.min(size, buffer.length - offset - 8) / byteRate) * 1000);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAVE file has no data chunk");
}

export function failures(report) {
  const found = [];
  for (const [name, metric] of Object.entries(report.metrics)) {
    for (const [side, errors] of Object.entries(metric.errors ?? {})) {
      if (errors.length > 0) found.push(`${name}: ${errors.length} failed on ${side}`);
    }
    if (metric.status === "failed") found.push(`${name}: ${metric.reason}`);
    if (metric.accuracy?.matchesBaseline === false) {
      found.push(`${name}: a candidate transcript differs from the baseline's`);
    }
  }
  return found;
}

const show = (value) => (value === null ? "-" : String(value));

export function formatTable(report) {
  const rows = [["metric", "measurement", "unit", "side", "n", "median", "min", "max", "verdict"]];
  for (const [name, metric] of Object.entries(report.metrics)) {
    if (metric.status !== "measured") {
      rows.push([name, `${metric.status}: ${metric.reason}`]);
      continue;
    }
    for (const [key, { unit, sides, comparison }] of Object.entries(metric.measurements)) {
      for (const [side, summary] of Object.entries(sides)) {
        rows.push([
          name,
          key,
          unit,
          side,
          show(summary.n),
          show(summary.median),
          show(summary.min),
          show(summary.max),
          side === "candidate" && comparison ? comparison.verdict : "",
        ]);
      }
    }
    for (const [side, errors] of Object.entries(metric.errors)) {
      for (const error of errors) rows.push([name, `error on ${side}: ${JSON.stringify(error)}`]);
    }
    for (const [fixtureName, { accuracy }] of Object.entries(metric.fixtures ?? {})) {
      for (const difference of accuracy?.differences ?? []) {
        rows.push([name, `${fixtureName} text differs: ${JSON.stringify(difference)}`]);
      }
    }
  }
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.filter((row) => row.length > 2).map((row) => row[column].length)),
  );
  return rows
    .map((row) =>
      row.length > 2
        ? row
            .map((cell, column) => cell.padEnd(widths[column]))
            .join("  ")
            .trimEnd()
        : row.join("  "),
    )
    .join("\n");
}
