#!/usr/bin/env node
// Measures the built renderer in the Electron the app ships: load, re-renders, memory and bundle
// size. No helper, model, microphone or user data is involved: a fake main (renderer-bench/main.mjs)
// serves seeded synthetic data over the same kind of bridge the app's preloads use.
//
//   node scripts/renderer-bench.mjs                       build, run every scenario 5 times
//   node scripts/renderer-bench.mjs --runs 3 --only pill,hub-cold
//   node scripts/renderer-bench.mjs --dist <dir>          use the build in <dir>, made if missing
//   node scripts/renderer-bench.mjs --build-only --dist <dir>
//   node scripts/renderer-bench.mjs --ab <before> <after> two built dirs, run turn about
//   node scripts/renderer-bench.mjs --compare before.json after.json
//
// A build in <dir> is never rebuilt, so a kept "before" build stays what it was. `--ab` runs each
// scenario on both builds back to back and swaps their order every run, so load on the machine
// and drift fall on both alike. It writes <out>.before.json and <out>.after.json and prints the
// comparison. Two sides differ only when their ranges over the runs do not overlap.
//
// Two builds of the unmodified renderer entries are measured. `prod` is the app's build and gives
// every wall-clock number, count and size. `profiling` is the same build with react-dom's
// profiling build, and gives the `react ms` rows only.
//
// Definitions. Every time is on the page's own clock, in ms since its navigation started:
//   first contentful paint   the browser's paint timing entry: the first frame with content on
//                   screen, after raster and the GPU process. The Flow Bar draws no text or
//                   image, so its row is the first paint entry.
//   react start     the first React commit, which is empty: the entry is fetched and evaluated.
//   first render    the first commit after which the page shows its content: the History
//                   heading and rows for the Voice window, the capsule for the Flow Bar.
//   interactive     the latest of that paint, the first frame the main thread finished after the
//                   first render, and the end of the last long task (over 50 ms) before the page
//                   went quiet for 500 ms.
//   renderer cpu    CPU time of the page's process on all its threads, from Electron's process
//                   metrics: since the process started for a cold start, per step elsewhere.
//                   Other work on the machine stretches every wall-clock row and barely moves
//                   this one, so it is the row to compare on a busy machine.
//   commit          one React commit of the root, seen through the DevTools global hook.
//   components      function, class, forwardRef and memo components whose code ran in a commit,
//                   counted as React DevTools counts them (see countRendered in preload.cjs).
//   react ms        render time of a commit (the root's actualDuration) plus its layout and
//                   passive effects. DOM mutation, style, layout and paint are not in it.
//   click→paint     from the click or keystroke to the next frame the main thread finished.
//   click→last commit   from the click to the last commit it caused, within 300 ms of quiet.
//                   It is later than the paint when the page waits for data or an exit animation.
//   push→commit     from a message of main reaching the page to the first commit it caused.
//   memory          JS heap in use after two forced collections, and live DOM nodes (attached or
//                   detached) and event listeners, sampled after each of 10 identical loops of a
//                   session: every page, Show more, scroll, search, 20 dictations, 100 snapshots.
//                   Growth per loop is the least-squares slope over loops 5 to 10.
// Each scenario runs in a fresh Electron process with a fresh profile. A scenario fails, and the
// script exits 1, when the page logs an error, calls a method the fake main does not answer, or
// does not show the rows the data predicts.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { compare, compareTable, entryAssets, median, table } from "./renderer-bench/stats.mjs";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const desktopDir = join(repoDir, "apps/desktop");
const benchDir = join(repoDir, "scripts/renderer-bench");
const bin = (name) => join(desktopDir, "node_modules/.bin", name);
const note = (message) => console.error(`[renderer-bench] ${message}`);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const output = (command, ...args) =>
  execFileSync(command, args, { cwd: repoDir, encoding: "utf8" }).trim();
const oneMinuteLoad = () => os.loadavg()[0] ?? 0;
const isBuilt = (dist) =>
  ["prod/hub.html", "profiling/hub.html", "build.json"].every((file) =>
    existsSync(join(dist, file)),
  );

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: "string", default: "5" },
    history: { type: "string", default: "5000" },
    meetings: { type: "string", default: "200" },
    seed: { type: "string", default: "1" },
    dist: { type: "string" },
    out: { type: "string", default: join(desktopDir, "dist/renderer-bench/result.json") },
    only: { type: "string" },
    "user-data": { type: "string", default: os.tmpdir() },
    "build-only": { type: "boolean", default: false },
    ab: { type: "boolean", default: false },
    compare: { type: "boolean", default: false },
  },
});

function build(dist) {
  const configs = { prod: [], profiling: ["--config", join(benchDir, "vite.config.mjs")] };
  for (const [name, config] of Object.entries(configs)) {
    note(`building ${name}`);
    execFileSync(bin("vp"), ["build", ...config, "--outDir", join(dist, name)], {
      cwd: desktopDir,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  const built = {
    sha: output("git", "rev-parse", "HEAD"),
    uncommitted: output("git", "status", "--porcelain", "--", "apps/desktop") !== "",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(dist, "build.json"), `${JSON.stringify(built)}\n`);
}

/** Raw and gzip bytes of what each page loads before it runs, and of every asset in the build. */
function bundle(dist) {
  const size = (files) => {
    const contents = files.map((file) => readFileSync(join(dist, file)));
    return {
      bytes: contents.reduce((sum, content) => sum + content.length, 0),
      "gzip bytes": contents.reduce((sum, content) => sum + gzipSync(content).length, 0),
    };
  };
  const all = readdirSync(join(dist, "assets")).map((file) => `assets/${file}`);
  const groups = {
    "all entries and lazy chunks": {
      js: all.filter((file) => file.endsWith(".js")),
      css: all.filter((file) => file.endsWith(".css")),
    },
  };
  for (const page of ["hub", "pill", "notepad"]) {
    groups[`${page}.html, loaded at start`] = entryAssets(
      readFileSync(join(dist, `${page}.html`), "utf8"),
    );
  }
  const metrics = {};
  for (const [group, kinds] of Object.entries(groups)) {
    for (const [kind, files] of Object.entries(kinds)) {
      for (const [unit, value] of Object.entries(size(files))) {
        metrics[`bundle, ${group} | ${kind} ${unit}`] = { build: "prod", values: [value] };
      }
    }
  }
  return metrics;
}

function electron(job, dist) {
  const userData = mkdtempSync(join(options["user-data"], "renderer-bench-"));
  const out = join(userData, "result.json");
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, RENDERER_BENCH: JSON.stringify({ ...job, dist, out, userData }) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(bin("electron"), [join(benchDir, "main.mjs")], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 600_000,
  });
  try {
    return read(out);
  } catch {
    const how = child.signal ?? `status ${child.status}`;
    return { metrics: {}, errors: [`Electron ended with ${how} and wrote no result`], info: {} };
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
}

function machine() {
  const mac = process.platform === "darwin";
  return {
    model: mac ? output("sysctl", "-n", "hw.model") : os.arch(),
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    os: mac ? `macOS ${output("sw_vers", "-productVersion")}` : `${os.type()} ${os.release()}`,
  };
}

function measure(sides) {
  const dataset = {
    history: Number(options.history),
    meetings: Number(options.meetings),
    seed: Number(options.seed),
  };
  const jobs = [
    { scenario: "hub-cold", history: 50 },
    ...[
      "hub-cold",
      "history-expand",
      "history-search",
      "history-patch",
      "snapshot-churn",
      "page-tour",
      "meetings",
      "pill",
      "memory",
    ].map((scenario) => ({ scenario, history: dataset.history })),
  ].filter(({ scenario }) => !options.only || options.only.split(",").includes(scenario));
  const runs = Number(options.runs);
  const taken = sides.map(() => ({ metrics: {}, profilingCounts: {}, errors: [], info: {} }));
  const load = [oneMinuteLoad()];
  for (let turn = 1; turn <= runs; turn += 1) {
    const order = turn % 2 === 1 ? sides : sides.toReversed();
    // The first launch of a turn, after the long memory scenario or none at all, starts slower
    // whatever it runs, so one cold start is made and thrown away before the measured ones.
    const warmUp = electron({ ...dataset, scenario: "hub-cold" }, join(order[0].dist, "prod"));
    note(`warm-up of run ${turn}/${runs}: ${warmUp.errors.length} errors`);
    for (const job of jobs) {
      // Heap and DOM counts need no profiling build.
      const builds = job.scenario === "memory" ? ["prod"] : ["prod", "profiling"];
      for (const side of order) {
        const { metrics, profilingCounts, errors, info } = taken[sides.indexOf(side)];
        for (const name of builds) {
          const started = Date.now();
          const result = electron({ ...dataset, ...job }, join(side.dist, name));
          Object.assign(info, result.info);
          const label = `${side.name}: ${job.scenario} (${job.history} entries, ${name}), run ${turn}/${runs}`;
          note(
            `${label}: ${((Date.now() - started) / 1000).toFixed(1)} s, ${result.errors.length} errors`,
          );
          errors.push(...result.errors.map((error) => `${label}: ${error}`));
          for (const [metric, value] of Object.entries(result.metrics)) {
            const fromProfiling = metric.includes("| react ms");
            if (name === "profiling" && /components|commits/.test(metric)) {
              (profilingCounts[metric] ??= []).push(value);
            }
            if (fromProfiling !== (name === "profiling")) continue;
            (metrics[metric] ??= { build: name, values: [] }).values.push(value);
          }
        }
      }
    }
    load.push(oneMinuteLoad());
  }
  return sides.map((side, i) => {
    const { metrics, profilingCounts, errors, info } = taken[i];
    return {
      meta: {
        date: new Date().toISOString(),
        source: process.env.CI ? "CI" : "local",
        build: read(join(side.dist, "build.json")),
        machine: machine(),
        react: read(join(desktopDir, "node_modules/react/package.json")).version,
        ...info,
        dataset: { ...dataset, coldHistory: [50, dataset.history] },
        runs,
        loadAverage: { min: Math.min(...load), max: Math.max(...load) },
        dist: side.dist,
        ranTurnAboutWith: sides.find((other) => other !== side)?.dist ?? null,
        // Both builds should do the same work. A row listed here did not.
        countsThatDifferInProfiling: Object.keys(profilingCounts).filter(
          (metric) => median(profilingCounts[metric]) !== median(metrics[metric].values),
        ),
      },
      metrics: { ...metrics, ...bundle(join(side.dist, "prod")) },
      errors,
    };
  });
}

function source(meta) {
  const { machine: on, loadAverage: load, dataset, build: built } = meta;
  return [
    `Source: ${meta.source}, ${on.model} (${on.cpu}, ${on.cores} cores, ${on.memoryGb} GB), ${on.os}`,
    `Electron ${meta.electron}, Chromium ${meta.chromium}, React ${meta.react}`,
    `window ${meta.window?.width}×${meta.window?.height} at ${meta.scaleFactor}x and ${Math.round(meta.refreshHz)} Hz`,
    `history ${dataset.coldHistory.join(" and ")} entries, ${dataset.meetings} meetings, ${meta.transcriptLines} transcript lines, seed ${dataset.seed}`,
    `${meta.runs} runs${meta.ranTurnAboutWith ? " turn about with the other side" : ""}, 1-minute load average ${load.min.toFixed(1)} to ${load.max.toFixed(1)}`,
    `built from git ${built.sha.slice(0, 7)}${built.uncommitted ? " with uncommitted changes in apps/desktop" : ""}, run ${meta.date}`,
  ].join("; ");
}

function write(file, result) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  note(`wrote ${file}`);
  for (const error of result.errors) note(`ERROR ${error}`);
  if (result.errors.length > 0) process.exitCode = 1;
}

function printComparison(before, after) {
  console.log(`Before. ${source(before.meta)}\nAfter. ${source(after.meta)}\n`);
  console.log(compareTable(compare(before.metrics, after.metrics)));
}

const out = resolve(options.out);
if (options.compare) {
  const [before, after] = positionals.map((file) => read(resolve(file)));
  if (!before || !after) throw new Error("--compare needs two result files");
  printComparison(before, after);
} else if (options.ab) {
  const [beforeDist, afterDist] = positionals.map((dist) => resolve(dist));
  if (!beforeDist || !afterDist || !isBuilt(beforeDist) || !isBuilt(afterDist)) {
    throw new Error("--ab needs two built dirs: make each with --build-only --dist <dir>");
  }
  const [before, after] = measure([
    { name: "before", dist: beforeDist },
    { name: "after", dist: afterDist },
  ]);
  write(out.replace(/(\.json)?$/, ".before.json"), before);
  write(out.replace(/(\.json)?$/, ".after.json"), after);
  printComparison(before, after);
} else {
  const dist = resolve(options.dist ?? join(desktopDir, "dist/renderer-bench/current"));
  if (!options.dist || !isBuilt(dist)) build(dist);
  if (options["build-only"]) {
    note(`the build is in ${dist}`);
  } else {
    const [result] = measure([{ name: "run", dist }]);
    write(out, result);
    console.log(`${source(result.meta)}\n\n${table(result.metrics)}`);
  }
}
