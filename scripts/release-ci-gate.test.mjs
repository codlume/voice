import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL(".", import.meta.url));

// Answers the gh calls the gate scripts make from JSON fixtures, then applies --jq like gh does.
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
jq_expr="."
for i in "\${!args[@]}"; do
  case "\${args[i]}" in
    --workflow) workflow="\${args[i+1]}" ;;
    --commit) commit="\${args[i+1]}" ;;
    --jq) jq_expr="\${args[i+1]}" ;;
  esac
done
case "$1 $2" in
  "run list")
    if [[ -n "\${commit:-}" ]]; then file="ci-\${commit}.json"; else file="runs-\${workflow}.json"; fi ;;
  "run view") file="jobs-$3.json" ;;
  "release list") file="releases.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 2 ;;
esac
if [[ -f "$FAKE_GH/\${file}" ]]; then jq -r "\${jq_expr}" "$FAKE_GH/\${file}"; else echo "[]" | jq -r "\${jq_expr}"; fi
`;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "voice-ci-gate-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  mkdirSync(join(dir, "scripts"));
  for (const name of ["release-ci-passed.sh", "deploy-due.sh", "release-nightly-due.sh"]) {
    copyFileSync(join(scripts, name), join(dir, "scripts", name));
  }
  writeFileSync(join(dir, "package.json"), '{ "version": "9.9.9" }\n');
  const fake = join(dir, ".fake-gh");
  mkdirSync(join(fake, "bin"), { recursive: true });
  writeFileSync(join(fake, "bin", "gh"), fakeGh);
  chmodSync(join(fake, "bin", "gh"), 0o755);
  const commit = (file, message) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), `${message}\n`);
    git("add", "-A", "--", ".", ":!.fake-gh");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const fixture = (name, value) => writeFileSync(join(fake, name), JSON.stringify(value));
  const run = (script, args = [], env = {}) => {
    const result = spawnSync("bash", [`scripts/${script}`, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        FAKE_GH: fake,
        PATH: `${join(fake, "bin")}:${process.env.PATH}`,
      },
    });
    return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
  };
  const ci = (sha, status, conclusion) => fixture(`ci-${sha}.json`, [{ status, conclusion }]);
  return { git, commit, fixture, run, ci };
}

test("CI gate passes only a finished green push run", () => {
  const r = repo();
  const sha = r.commit("README.md", "init");
  r.ci(sha, "completed", "success");
  assert.equal(r.run("release-ci-passed.sh", [sha]).code, 0);
  for (const [status, conclusion] of [
    ["in_progress", ""],
    ["completed", "failure"],
    ["completed", "cancelled"],
  ]) {
    r.ci(sha, status, conclusion);
    const result = r.run("release-ci-passed.sh", [sha]);
    assert.equal(result.code, 1, `${status}/${conclusion}`);
    assert.match(result.err, new RegExp(`::warning::CI on ${sha} is ${status}`));
  }
  const missing = r.run("release-ci-passed.sh", ["0".repeat(40)]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /is missing; not shipping it/);
});

test("deploy waits for green CI, even on a manual run", () => {
  const r = repo();
  const sha = r.commit("apps/web/index.html", "web");
  r.ci(sha, "completed", "failure");
  assert.equal(
    r.run("deploy-due.sh", ["web.yml", "apps/web"], { MANUAL: "true" }).out,
    "due=false",
  );
  r.ci(sha, "completed", "success");
  assert.equal(r.run("deploy-due.sh", ["web.yml", "apps/web"], { MANUAL: "true" }).out, "due=true");
});

test("deploy diffs against the last run that really deployed", () => {
  const r = repo();
  const deployed = r.commit("apps/web/index.html", "deployed");
  const failedCi = r.commit("apps/web/index.html", "web change whose CI failed");
  const docs = r.commit("docs/notes.md", "docs only");
  r.ci(docs, "completed", "success");
  r.fixture("runs-web.yml.json", [
    { databaseId: 2, headSha: failedCi },
    { databaseId: 1, headSha: deployed },
  ]);
  r.fixture("jobs-2.json", {
    jobs: [
      { name: "due", conclusion: "success" },
      { name: "deploy", conclusion: "skipped" },
    ],
  });
  r.fixture("jobs-1.json", { jobs: [{ name: "deploy", conclusion: "success" }] });
  const result = r.run("deploy-due.sh", ["web.yml", "apps/web"]);
  assert.equal(result.out, "due=true");
  assert.match(result.err, new RegExp(`Deploying changes since ${deployed}`));

  r.fixture("runs-web.yml.json", [{ databaseId: 3, headSha: failedCi }]);
  r.fixture("jobs-3.json", { jobs: [{ name: "deploy", conclusion: "success" }] });
  assert.equal(r.run("deploy-due.sh", ["web.yml", "apps/web"]).out, "due=false");
});

test("deploy never replaces a newer deploy with an older commit", () => {
  const r = repo();
  const older = r.commit("apps/web/index.html", "older");
  const newer = r.commit("apps/web/index.html", "newer");
  r.git("checkout", "-q", older);
  r.ci(older, "completed", "success");
  r.fixture("runs-web.yml.json", [{ databaseId: 1, headSha: newer }]);
  r.fixture("jobs-1.json", { jobs: [{ name: "deploy", conclusion: "success" }] });
  const result = r.run("deploy-due.sh", ["web.yml", "apps/web"]);
  assert.equal(result.out, "due=false");
  assert.match(result.err, /is already deployed/);
});

test("deploy runs when no earlier deploy is found", () => {
  const r = repo();
  const sha = r.commit("apps/web/index.html", "first");
  r.ci(sha, "completed", "success");
  assert.equal(r.run("deploy-due.sh", ["web.yml", "apps/web"]).out, "due=true");
});

test("Nightly is not due without green CI, even on a manual run", () => {
  const r = repo();
  const sha = r.commit("apps/desktop/main.ts", "change");
  r.ci(sha, "in_progress", "");
  const blocked = r.run("release-nightly-due.sh", [], { MANUAL: "true" });
  assert.equal(blocked.code, 0);
  assert.match(blocked.out, /^due=false$/m);
  r.ci(sha, "completed", "success");
  assert.match(r.run("release-nightly-due.sh", [], { MANUAL: "true" }).out, /^due=true$/m);
  assert.match(r.run("release-nightly-due.sh").out, /^due=true$/m);
});
