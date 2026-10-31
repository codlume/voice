import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { writeFileAtomic } from "./atomic-file.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(NodePath.join(tmpdir(), "voice-atomic-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("overlapping writes of one file all succeed and the last one called is what stays", async () => {
  const file = NodePath.join(dir, "notepad.json");
  const writes = Array.from({ length: 20 }, (_, index) =>
    writeFileAtomic(file, JSON.stringify({ x: index, padding: "x".repeat(index * 5000) })),
  );
  await expect(Promise.all(writes)).resolves.toBeDefined();
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ x: 19 });
  expect(await readdir(dir)).toEqual(["notepad.json"]);
});

test("a failed write does not stop the next one", async () => {
  const file = NodePath.join(dir, "settings.json");
  const failed = writeFileAtomic(file, "first", { mode: -1 });
  const next = writeFileAtomic(file, "second");
  await expect(failed).rejects.toThrow();
  await next;
  expect(await readFile(file, "utf8")).toBe("second");
  expect(await readdir(dir)).toEqual(["settings.json"]);
});
