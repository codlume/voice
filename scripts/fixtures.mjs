import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
export const fixturesDir = join(repoDir, "test-fixtures/audio");

export const fixtures = [
  {
    name: "short.wav",
    speech:
      "Hi Anna, can we move our meeting to Thursday at three thirty? Let me know if that works.",
  },
  {
    name: "long.wav",
    speech:
      "So, um, I was thinking we should, uh, we should probably start the migration on March twelfth. " +
      "Actually no, wait, let's do the fifteenth instead. " +
      "There are about forty two thousand records in the old table, and, like, most of them haven't been touched since two thousand nineteen. " +
      "Anyway, I'll, uh, I'll write up the plan tonight and send it over tomorrow morning, so, yeah, let me know what you think.",
  },
  { name: "silence.wav", silenceSeconds: 2 },
  { name: "url.wav", speech: "open github dot com slash pingdotgg" },
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function generate(fixture) {
  const target = join(fixturesDir, fixture.name);
  const encode = ["-y", "-loglevel", "error"];
  if ("silenceSeconds" in fixture) {
    run("ffmpeg", [
      ...encode,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      String(fixture.silenceSeconds),
      "-c:a",
      "pcm_s16le",
      target,
    ]);
    return;
  }
  const aiff = join(tmpdir(), `voice-fixture-${process.pid}-${fixture.name}.aiff`);
  try {
    run("say", ["-o", aiff, fixture.speech]);
    run("ffmpeg", [...encode, "-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", target]);
  } finally {
    rmSync(aiff, { force: true });
  }
}

export function ensureFixtures() {
  mkdirSync(fixturesDir, { recursive: true });
  for (const fixture of fixtures) {
    const target = join(fixturesDir, fixture.name);
    if (existsSync(target)) continue;
    generate(fixture);
    console.log(`generated ${target}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) ensureFixtures();
