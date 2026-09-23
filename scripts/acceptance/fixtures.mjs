// Fixture recovery and held-out generation. Audio lives in .acceptance/, never in the repository;
// tests/acceptance/fixtures.json freezes every hash and source reference.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { classOf, mix, noise, rms, sha256, wav, wavPcm } from "./lib.mjs";

const run = promisify(execFile);
export const root = resolve(import.meta.dirname, "../..");
export const work = join(root, ".acceptance");
const catalogPath = join(root, "tests/acceptance/fixtures.json");
const heldoutPath = join(root, "tests/acceptance/heldout.json");

export const loadCatalog = async () => JSON.parse(await readFile(catalogPath, "utf8"));
export const fixturePath = (fixture) =>
  join(work, "fixtures", fixture.source.archive, fixture.source.path);

async function download(archive) {
  const target = join(work, "archives", `${archive.name}-${archive.part}.tgz`);
  if (!existsSync(target)) {
    if (!archive.url)
      throw new Error(`${target} is missing and ${archive.name} is not published yet`);
    await mkdir(join(work, "archives"), { recursive: true });
    // Private-repository attachments need the maintainer's GitHub session; it never leaves gh.
    const { stdout: token } = await run("gh", ["auth", "token"]);
    const response = await fetch(archive.url, {
      headers: { Authorization: `token ${token.trim()}` },
    });
    if (!response.ok) throw new Error(`download ${archive.url}: ${response.status}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
  }
  const data = await readFile(target);
  if (data.length !== archive.bytes || sha256(data) !== archive.sha256)
    throw new Error(`archive ${target} does not match its published hash`);
  return target;
}

// Download, verify, and extract every published archive, then verify every fixture's hash.
export async function recover() {
  const catalog = await loadCatalog();
  for (const archive of catalog.archives) {
    const file = await download(archive);
    const directory = join(work, "fixtures", archive.name);
    await mkdir(directory, { recursive: true });
    await run("tar", ["xzf", file, "-C", directory]);
  }
  return verify(catalog);
}
// `ids` limits the check to the fixtures a manifest uses; recovery checks the whole catalog.
export async function verify(catalog, ids) {
  const problems = [];
  const fixtures = ids
    ? catalog.fixtures.filter((item) => ids.includes(item.id))
    : catalog.fixtures;
  for (const fixture of fixtures) {
    const file = fixturePath(fixture);
    if (!existsSync(file)) {
      problems.push(`${fixture.id}: missing ${file}`);
      continue;
    }
    const data = await readFile(file);
    if (sha256(data) !== fixture.sha256) problems.push(`${fixture.id}: hash mismatch`);
    else if (wavPcm(data).length / 32_000 !== fixture.seconds)
      problems.push(`${fixture.id}: duration`);
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return fixtures.length;
}

async function speak(voice, text, directory, index) {
  const file = join(directory, `${index}.wav`);
  await run("say", [
    "-v",
    voice,
    "--file-format=WAVE",
    "--data-format=LEI16@16000",
    "-o",
    file,
    text,
  ]);
  return wavPcm(await readFile(file));
}
// Generate held-out WAVs from heldout.json. Hashes differ across macOS voice versions, so this runs
// once to freeze; afterwards the published archive, not regeneration, is the source.
export async function generate() {
  const spec = JSON.parse(await readFile(heldoutPath, "utf8"));
  const out = join(work, "fixtures", "heldout", "heldout");
  await mkdir(out, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), "voice-heldout-"));
  const results = [];
  try {
    for (const fixture of spec.fixtures) {
      const parts = [];
      let index = 0;
      for (const utterance of fixture.utterances) {
        const { text, pauseAfterMs } =
          typeof utterance === "string"
            ? { text: utterance, pauseAfterMs: fixture.gapMs }
            : utterance;
        parts.push(await speak(fixture.voice, text, scratch, index++));
        if (pauseAfterMs) parts.push(Buffer.alloc(Math.round(pauseAfterMs * 16) * 2));
      }
      let pcm = Buffer.concat(parts);
      const total = fixture.seconds * 32_000;
      if (pcm.length > total) throw new Error(`${fixture.id}: speech is ${pcm.length / 32_000}s`);
      pcm = Buffer.concat([pcm, Buffer.alloc(total - pcm.length)]);
      if (fixture.noise) {
        const amplitude = fixture.noise.amplitude ?? rms(pcm) / 10 ** (fixture.noise.snrDb / 20);
        pcm = mix(pcm, noise(pcm.length / 2, fixture.noise.seed, amplitude));
      }
      const data = wav(pcm);
      await writeFile(join(out, `${fixture.id}.wav`), data);
      const spoken = fixture.utterances
        .map((utterance) => (typeof utterance === "string" ? utterance : utterance.text))
        .join(" ");
      results.push({
        id: fixture.id,
        sha256: sha256(data),
        seconds: fixture.seconds,
        class: classOf(fixture.seconds),
        coverage: fixture.coverage,
        voice: fixture.voice ?? null,
        source: { archive: "heldout", path: `heldout/${fixture.id}.wav` },
        expected: spoken ? "text" : "empty",
        spoken,
        intended: fixture.intended ?? spoken,
        provenance: fixture.noise
          ? `${spec.provenance} ${spec.noiseProvenance}`
          : spoken
            ? spec.provenance
            : spec.noiseProvenance,
        heldOut: true,
      });
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await run("tar", [
    "czf",
    join(work, "heldout.tgz"),
    "-C",
    join(work, "fixtures", "heldout"),
    "heldout",
  ]);
  return results;
}
