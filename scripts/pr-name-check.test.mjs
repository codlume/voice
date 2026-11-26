import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("pr-name-check.sh", import.meta.url));

function check(title, branch) {
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { ...process.env, TITLE: title, BRANCH: branch },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

// Bots open these PRs with names they choose. If a rule rejects one, that bot's PRs
// can never go green, as release 0.21.0 (#316) could not.
const botPullRequests = [
  ["chore(main): release 0.21.0", "release-please--branches--main--components--voice"],
  ["chore(main): release 0.21.0", "release-please--branches--main"],
  ["build(deps): bump electron from 39.0.0 to 39.1.0", "dependabot/npm_and_yarn/electron-39.1.0"],
  ["chore(deps): update dependency vite to v8", "renovate/vite-8.x"],
];

for (const [title, branch] of botPullRequests) {
  test(`passes the bot PR ${branch}`, () => {
    const { status, output } = check(title, branch);
    assert.equal(status, 0, output);
  });
}

test("passes a semantic title and branch", () => {
  const { status, output } = check("fix(helper): stop the download", "fix/helper-download");
  assert.equal(status, 0, output);
  assert.match(output, /ok: fix\/helper-download/);
});

const rejected = [
  {
    name: "a branch without a type",
    title: "fix: stop the download",
    branch: "helper-download",
    error: /branch is not semantic/,
  },
  {
    name: "a branch that only starts like release-please",
    title: "fix: x",
    branch: "release-please-hack",
    error: /branch is not semantic/,
  },
  {
    name: "a title without a type",
    title: "Stop the download",
    branch: "fix/x",
    error: /PR title is not semantic/,
  },
  {
    name: "a title that starts with a ticket key",
    title: "VOICE-12 fix: x",
    branch: "fix/x",
    error: /starts with a ticket key/,
  },
  {
    name: "a ticket key as the scope",
    title: "fix(VOICE-12): x",
    branch: "fix/x",
    error: /carries a ticket key/,
  },
  {
    name: "a bot branch with a bad title",
    title: "Release 0.21.0",
    branch: "release-please--branches--main",
    error: /PR title is not semantic/,
  },
];

for (const { name, title, branch, error } of rejected) {
  test(`rejects ${name}`, () => {
    const { status, output } = check(title, branch);
    assert.equal(status, 1, output);
    assert.match(output, error);
  });
}
