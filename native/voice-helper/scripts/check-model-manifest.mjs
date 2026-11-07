#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UA = "Mozilla/5.0 (compatible; generic-http-client)";
const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
const localRoot = dirIndex >= 0 ? args[dirIndex + 1] : null;
const offline = args.includes("--offline");
const unknown = args.filter(
  (a, i) =>
    (a.startsWith("--") && !["--dir", "--offline"].includes(a)) ||
    (i > 0 && args[i - 1] !== "--dir" && !a.startsWith("--")),
);
if ((dirIndex >= 0 && !localRoot) || (offline && !localRoot) || unknown.length) {
  console.error("usage: node scripts/check-model-manifest.mjs [--dir <models dir>] [--offline]");
  process.exit(2);
}

const swiftPath = fileURLToPath(
  new URL("../Sources/VoiceHelperCore/ModelManifest.swift", import.meta.url),
);

function readSwiftManifest(source) {
  const models = [];
  const releasePattern = /public static let (\w+) = ModelRelease\(([\s\S]*?)\n {8}marker:/g;
  for (const [, id, body] of source.matchAll(releasePattern)) {
    const field = (name) => body.match(new RegExp(`${name}: "([^"]*)"`))?.[1];
    const files = [
      ...body.matchAll(/^ {12}ModelFile\("([^"]*)", size: (\d+), sha256: "([0-9a-f]*)"\),$/gm),
    ].map(([, path, size, sha256]) => ({ path, size: Number(size), sha256 }));
    const fileLines = body.split("\n").filter((line) => line.includes("ModelFile(")).length;
    if (fileLines !== files.length)
      throw new Error(
        `${id}: ${fileLines} ModelFile lines but ${files.length} parsed; keep one literal per line`,
      );
    models.push({
      id,
      repository: field("repository"),
      folderName: field("folderName"),
      revision: field("revision"),
      files,
    });
  }
  if (models.length === 0) throw new Error(`no ModelRelease literals found in ${swiftPath}`);
  return { models };
}

const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`  FAIL ${msg}`);
};

function checkShape(model, seenIds) {
  if (seenIds.has(model.id)) fail(`duplicate model id ${model.id}`);
  seenIds.add(model.id);
  if (!/^[0-9a-f]{40}$/.test(model.revision ?? "")) fail(`${model.id}: revision is not 40 hex`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model.repository ?? ""))
    fail(`${model.id}: bad repository`);
  if (!/^[A-Za-z0-9_.-]+$/.test(model.folderName ?? "") || model.folderName === "..")
    fail(`${model.id}: bad folderName`);
  const paths = model.files.map((f) => f.path);
  const sorted = paths.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) fail(`${model.id}: paths not sorted`);
  if (new Set(paths).size !== paths.length) fail(`${model.id}: duplicate paths`);
  for (const f of model.files) {
    const parts = f.path.split("/");
    if (
      f.path.startsWith("/") ||
      f.path.includes("\\") ||
      parts.some((p) => p === "" || p === "." || p === "..") ||
      /[^\x20-\x7e]/.test(f.path)
    )
      fail(`${model.id}: unsafe path ${JSON.stringify(f.path)}`);
    if (!Number.isSafeInteger(f.size) || f.size <= 0)
      fail(`${model.id}/${f.path}: bad size ${f.size}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) fail(`${model.id}/${f.path}: sha256 is not 64 hex`);
  }
}

const nextLink = (link) =>
  link
    ?.split(",")
    .map((s) => s.trim())
    .find((s) => /rel="?next"?/.test(s))
    ?.match(/<([^>]+)>/)?.[1] ?? null;

async function getJsonPages(firstUrl) {
  const items = [];
  for (let url = firstUrl; url;) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
    items.push(...(await res.json()));
    url = nextLink(res.headers.get("link"));
  }
  return items;
}

const gitBlob = (buffer) =>
  createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
const pointerBlob = (entry) =>
  gitBlob(
    Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${entry.lfs.oid}\nsize ${entry.lfs.size}\n`,
    ),
  );

async function hashFile(path, size) {
  const sha256 = createHash("sha256");
  const blob = createHash("sha1").update(`blob ${size}\0`);
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk);
    blob.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: sha256.digest("hex"), blob: blob.digest("hex"), bytes };
}

function listFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(root, rel) : [rel];
  });
}

async function checkRemote(model) {
  const { repository, revision } = model;
  const commits = await getJsonPages(
    `https://huggingface.co/api/models/${repository}/commits/main`,
  );
  const position = commits.findIndex((c) => c.id === revision);
  if (position < 0) fail(`${model.id}: ${revision} is not in commits/main`);
  console.log(
    `  commit ${revision}: position ${position} of ${commits.length} on main (0 = head, head ${commits[0].id})`,
  );

  const tree = await getJsonPages(
    `https://huggingface.co/api/models/${repository}/tree/${revision}?recursive=true`,
  );
  const byPath = new Map(tree.map((e) => [e.path, e]));
  console.log(`  tree ${revision}: ${tree.length} entries`);
  const counts = { lfs: 0, lfsPass: 0, git: 0, gitPass: 0 };

  for (const f of model.files) {
    const entry = byPath.get(f.path);
    if (!entry) {
      fail(`${model.id}/${f.path}: absent from tree`);
      continue;
    }
    if (entry.type !== "file") {
      fail(`${model.id}/${f.path}: tree type ${entry.type}`);
      continue;
    }
    const before = failures.length;
    if (entry.size !== f.size) fail(`${model.id}/${f.path}: tree size ${entry.size} != ${f.size}`);
    if (entry.lfs) {
      counts.lfs++;
      if (entry.lfs.oid !== f.sha256)
        fail(`${model.id}/${f.path}: lfs.oid ${entry.lfs.oid} != ${f.sha256}`);
      if (entry.lfs.size !== f.size)
        fail(`${model.id}/${f.path}: lfs.size ${entry.lfs.size} != ${f.size}`);
      if (pointerBlob(entry) !== entry.oid) fail(`${model.id}/${f.path}: pointer blob != tree oid`);
      if (failures.length === before) counts.lfsPass++;
    } else {
      counts.git++;
      const res = await fetch(
        `https://huggingface.co/${repository}/resolve/${revision}/${f.path.split("/").map(encodeURIComponent).join("/")}`,
        { headers: { "User-Agent": UA } },
      );
      if (res.status !== 200) {
        fail(`${model.id}/${f.path}: HTTP ${res.status}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length !== f.size)
        fail(`${model.id}/${f.path}: fetched ${bytes.length} bytes, manifest ${f.size}`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== f.sha256)
        fail(`${model.id}/${f.path}: fetched sha256 ${sha256} != ${f.sha256}`);
      const blob = gitBlob(bytes);
      if (blob !== entry.oid)
        fail(`${model.id}/${f.path}: blob sha1 ${blob} != tree oid ${entry.oid}`);
      if (failures.length === before) counts.gitPass++;
    }
  }

  const bundles = new Set(
    model.files.map((f) => f.path.split("/")[0]).filter((p) => p.endsWith(".mlmodelc")),
  );
  const listed = new Set(model.files.map((f) => f.path));
  const omitted = tree.filter(
    (e) => e.type === "file" && bundles.has(e.path.split("/")[0]) && !listed.has(e.path),
  );
  for (const e of omitted)
    fail(`${model.id}/${e.path}: in a required bundle but not in the manifest`);
  console.log(
    `  tree check: LFS ${counts.lfsPass}/${counts.lfs} pass, non-LFS ${counts.gitPass}/${counts.git} pass, bundles complete ${omitted.length === 0 ? "yes" : "NO"} (${bundles.size})`,
  );
  return byPath;
}

async function checkLocal(model, byPath) {
  const root = join(localRoot, model.folderName);
  let pass = 0;
  for (const f of model.files) {
    const path = join(root, f.path);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      fail(`${model.id}/${f.path}: missing locally`);
      continue;
    }
    if (!stat.isFile()) {
      fail(`${model.id}/${f.path}: not a regular file`);
      continue;
    }
    const before = failures.length;
    const got = await hashFile(path, stat.size);
    if (got.bytes !== f.size) fail(`${model.id}/${f.path}: local size ${got.bytes} != ${f.size}`);
    if (got.sha256 !== f.sha256)
      fail(`${model.id}/${f.path}: local sha256 ${got.sha256} != ${f.sha256}`);
    const entry = byPath?.get(f.path);
    if (entry && !entry.lfs && got.blob !== entry.oid)
      fail(`${model.id}/${f.path}: local blob sha1 ${got.blob} != tree oid ${entry.oid}`);
    if (failures.length === before) pass++;
  }
  const listed = new Set(model.files.map((f) => f.path));
  let extras = [];
  try {
    extras = listFiles(root).filter((p) => !listed.has(p));
  } catch {
    extras = ["(folder missing)"];
  }
  console.log(
    `  local check: ${pass}/${model.files.length} pass in ${root}; files not in manifest: ${extras.length ? extras.join(", ") : "none"}`,
  );
}

const manifest = readSwiftManifest(readFileSync(swiftPath, "utf8"));
const seenIds = new Set();
console.log(
  `manifest ${swiftPath}: ${manifest.models.length} models, checked ${new Date().toISOString()}`,
);
for (const model of manifest.models) {
  const total = model.files.reduce((n, f) => n + f.size, 0);
  console.log(
    `${model.id} ${model.repository}@${model.revision}: ${model.files.length} files, ${total} bytes`,
  );
  checkShape(model, seenIds);
  const byPath = offline ? null : await checkRemote(model);
  if (localRoot) await checkLocal(model, byPath);
}
console.log(failures.length ? `RESULT FAIL (${failures.length})` : "RESULT PASS");
process.exit(failures.length ? 1 : 0);
