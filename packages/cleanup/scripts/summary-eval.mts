// Runs the Gemma summary provider over the synthetic meetings in test-fixtures/meetings and scores
// each summary against the fixture's answer key: hit or miss per decision and action, the action's
// owner, traps the summary fell for, the Next Steps bullet count, and timings.
//
//   node packages/cleanup/scripts/summary-eval.mts [fixture ids] [--model <gguf>] [--out <dir>]
//   node packages/cleanup/scripts/summary-eval.mts --rescore <dir>
//
// --rescore scores the `<fixture>*.md` summaries already in a folder, without the model, so an
// older run and a new one are scored by the same rules. Traps are keyword matches: read the
// flagged lines, because a correct "contractors were rejected" matches the rejected-contractors trap.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createGemmaSummaryProvider, estimateTokens } from "../src/summary/gemma.ts";
import { SUMMARY_LANGUAGES } from "../src/summary/language.ts";
import { renderSummaryMarkdown, SPEAKER_TOKEN } from "../src/summary/markdown.ts";
import type { Speaker, TranscriptLine } from "../src/summary/provider.ts";
import { createTransformEngine } from "../src/transform/engine.ts";

const FIXTURES = new URL("../../../test-fixtures/meetings/", import.meta.url).pathname;
const DEFAULT_MODEL = join(
  homedir(),
  "Library/Caches/Voice Development/test-models/gemma-4-E2B-it-Q4_K_M.gguf",
);

type Groups = string[][];
type Key = {
  notes: string;
  decisions: { id: string; mustMention: Groups }[];
  actions: { id: string; owner: string; mustMention: Groups }[];
  traps: {
    id: string;
    kind: string;
    mustNotAppearAs: "decision" | "action";
    keywords: Groups;
    wrongOwner?: string;
  }[];
};

const fold = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ł/g, "l");
const matches = (line: string, groups: Groups) =>
  groups.every((group) => group.some((alt) => fold(line).includes(fold(alt))));

const headings = Object.values(SUMMARY_LANGUAGES);

function sections(markdown: string) {
  const [overview = "", ...parts] = markdown.split(/^###\s+/m);
  const section = (names: string[]) =>
    parts.find((part) => names.includes(part.split("\n")[0]!.trim())) ?? "";
  const decisions = section(headings.map((heading) => heading.decisions))
    .split("\n")
    .filter((line) => /^\s*[-*]/.test(line));
  const actions: { owner: string; line: string }[] = [];
  let owner = "";
  for (const line of section(headings.map((heading) => heading.nextSteps))
    .split("\n")
    .slice(1)) {
    const bold = line.match(/^\s*\*\*(.+?)\*\*\s*:?\s*$/);
    if (bold) owner = bold[1]!.replace(/:$/, "").trim();
    else if (/^\s*[-*]/.test(line)) actions.push({ owner, line });
  }
  return { overview: overview.trim(), decisions, actions };
}

const count = (items: { hit: boolean }[]) => items.filter(({ hit }) => hit).length;

function score(fixture: string, markdown: string) {
  const key = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.key.json`), "utf8")) as Key;
  const s = sections(markdown);
  const decisions = key.decisions.map((d) => ({
    id: d.id,
    hit: s.decisions.some((line) => matches(line, d.mustMention)),
  }));
  const actions = key.actions.map((a) => {
    const found = s.actions.filter(({ line }) => matches(line, a.mustMention));
    return {
      id: a.id,
      hit: found.length > 0,
      owner: found.some(({ owner }) => owner === a.owner),
      owners: found.map(({ owner }) => owner),
    };
  });
  const traps = key.traps.flatMap((t) => {
    const pool =
      t.mustNotAppearAs === "decision"
        ? s.decisions
        : s.actions
            .filter(({ owner }) => !t.wrongOwner || owner === t.wrongOwner)
            .map(({ line }) => line);
    const lines = pool.filter((line) => matches(line, t.keywords));
    return lines.length > 0 ? [{ id: t.id, kind: t.kind, lines }] : [];
  });
  return {
    decisions: `${count(decisions)}/${decisions.length}`,
    actions: `${count(actions)}/${actions.length}`,
    owners: `${actions.filter(({ owner }) => owner).length}/${actions.length}`,
    bullets: s.actions.length,
    ownerGroups: [...new Set(s.actions.map(({ owner }) => owner))],
    missedDecisions: decisions.filter(({ hit }) => !hit).map(({ id }) => id),
    missedActions: actions.filter(({ hit }) => !hit).map(({ id }) => id),
    wrongOwner: actions
      .filter(({ hit, owner }) => hit && !owner)
      .map(({ id, owners }) => `${id}->${owners.join("|")}`),
    traps,
  };
}

function print(
  name: string,
  fixture: string,
  markdown: string,
  extra: Record<string, unknown> = {},
) {
  const result = score(fixture, markdown);
  const traps = result.traps.map(({ id, kind }) => `${id}(${kind})`).join(" ") || "none";
  console.log(
    [
      name.padEnd(10),
      `decisions ${result.decisions}`,
      `actions ${result.actions}`,
      `owners ${result.owners}`,
      `bullets ${result.bullets}`,
      `traps ${traps}`,
      ...Object.entries(extra).map(([field, value]) => `${field} ${String(value)}`),
    ].join("  "),
  );
  const misses = [
    result.missedDecisions.length > 0 && `missed decisions ${result.missedDecisions.join(" ")}`,
    result.missedActions.length > 0 && `missed actions ${result.missedActions.join(" ")}`,
    result.wrongOwner.length > 0 && `wrong owner ${result.wrongOwner.join(" ")}`,
    `owner groups ${result.ownerGroups.join(", ")}`,
  ].filter(Boolean);
  console.log(`  ${misses.join("; ")}`);
  for (const trap of result.traps) {
    for (const line of trap.lines) console.log(`  trap ${trap.id} (${trap.kind}): ${line.trim()}`);
  }
  return result;
}

// The fixtures' labels as the app's speaker ids: You is "you", Speaker N is "sN".
const idOf = (label: string) => (label === "You" ? "you" : label.replace(/^Speaker (\d+)$/, "s$1"));
const labelOf = (id: string) => (id === "you" ? "You" : id.replace(/^s(\d+)$/, "Speaker $1"));

function readFixture(fixture: string): {
  lines: TranscriptLine[];
  speakers: Speaker[];
  notes: string;
} {
  const key = JSON.parse(readFileSync(join(FIXTURES, `${fixture}.key.json`), "utf8")) as Key;
  const lines = readFileSync(join(FIXTURES, `${fixture}.txt`), "utf8")
    .split("\n")
    .flatMap((line): TranscriptLine[] => {
      const match = line.match(/^\[(\d+):(\d+):(\d+)\]\s*([^:]+):\s*(.*)$/);
      if (!match) return [];
      const [, h, m, sec, label, text] = match;
      const startMs = ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000;
      return [{ speaker: idOf(label!.trim()), startMs, text: text!.trim() }];
    });
  const speakers = [...new Set(lines.map(({ speaker }) => speaker))].map((id) => ({
    id,
    label: labelOf(id),
  }));
  return { lines, speakers, notes: key.notes };
}

const asLabels = (markdown: string) =>
  markdown.replace(SPEAKER_TOKEN, (_, id: string) => labelOf(id));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: DEFAULT_MODEL },
    out: { type: "string", default: `/tmp/voice-summary-eval/${Date.now()}` },
    rescore: { type: "string" },
  },
});

if (values.rescore) {
  for (const name of readdirSync(values.rescore)
    .filter((file) => file.endsWith(".md"))
    .toSorted()) {
    const fixture = name.match(/^([a-z]{2}-\d{2})/)?.[1];
    if (!fixture) continue;
    const text = readFileSync(join(values.rescore, name), "utf8").replace(/^# .*\n+/, "");
    print(name.replace(/\.md$/, ""), fixture, asLabels(text));
  }
  process.exit(0);
}

const fixtures = positionals.length > 0 ? positionals : ["en-05", "en-30", "pl-30", "en-90"];
mkdirSync(values.out, { recursive: true });
const engine = createTransformEngine({ modelPath: values.model });
const loadStart = performance.now();
await engine.load();
const loadMs = Math.round(performance.now() - loadStart);
console.log(`model loaded in ${loadMs} ms; output in ${values.out}`);

const summary: Record<string, unknown>[] = [];
for (const fixture of fixtures) {
  const { lines, speakers, notes } = readFixture(fixture);
  const steps: { ms: number; user: string; output: string; truncated: boolean }[] = [];
  const provider = createGemmaSummaryProvider({
    tokens: estimateTokens,
    generate: async (request) => {
      const start = performance.now();
      const result = await engine.generate({ ...request, budgetMs: 600_000 });
      steps.push({
        ms: Math.round(performance.now() - start),
        user: request.user,
        output: result.ok ? result.text : result.failure.kind,
        truncated: result.ok && result.truncated,
      });
      return result;
    },
  });
  const start = performance.now();
  const result = await provider.summarize({
    lines,
    speakers,
    notes,
    title: "generate",
    signal: new AbortController().signal,
  });
  const totalMs = Math.round(performance.now() - start);
  if (!result.ok) {
    console.log(`${fixture}: failed ${result.failure.kind} after ${totalMs} ms`);
    continue;
  }
  const markdown = renderSummaryMarkdown(result.summary, speakers);
  writeFileSync(
    join(values.out, `${fixture}.md`),
    `# ${result.summary.title ?? ""}\n\n${markdown}`,
  );
  writeFileSync(join(values.out, `${fixture}.json`), JSON.stringify({ result, steps }, null, 2));
  const scored = print(fixture, fixture, asLabels(markdown), {
    s: (totalMs / 1000).toFixed(1),
    steps: steps.map(({ ms }) => (ms / 1000).toFixed(1)).join("+"),
    title: JSON.stringify(result.summary.title),
  });
  summary.push({ fixture, totalMs, steps, title: result.summary.title, ...scored });
}
writeFileSync(join(values.out, "score.json"), JSON.stringify(summary, null, 2));
await engine.dispose();
