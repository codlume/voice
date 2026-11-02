// Captures every help screenshot from the renderer preview harness and records where each callout
// lands. `--check` captures nothing and fails when a shot's clip or callout no longer matches the UI.
//
//   node scripts/help-shots.mjs [--check]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { helpTopics } from "../apps/desktop/src/renderer/help/topics.ts";
import { Page, repoDir, stopChildrenOnSignal } from "./voice-app.mjs";

const check = process.argv.includes("--check");
const helpDir = join(repoDir, "apps/desktop/src/renderer/help");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const viewport = { width: 1100, height: 760 };
const pad = 12;
const round = (n) => Math.round(n * 1000) / 1000;

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function until(read, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

stopChildrenOnSignal();
const vitePort = await freePort();
const chromePort = await freePort();
const children = [
  spawn(
    join(repoDir, "apps/desktop/node_modules/.bin/vp"),
    ["dev", "--port", String(vitePort), "--strictPort"],
    { cwd: join(repoDir, "apps/desktop"), stdio: "ignore", detached: true },
  ),
  spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${mkdtempSync(join(tmpdir(), "help-shots-"))}`,
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  ),
];
const stop = () => children.forEach((child) => process.kill(-child.pid, "SIGTERM"));

const shots = topicsShots();
const layouts = {};
const problems = [];
try {
  await until(() => fetch(`http://localhost:${vitePort}/preview.html`).then((r) => r.ok), "vite");
  const page = await Page.connect(chromePort, "about:blank");
  await page.call("Emulation.setDeviceMetricsOverride", {
    ...viewport,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.call("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: "light" },
    ],
  });
  for (const shot of shots) {
    const url = `http://localhost:${vitePort}/preview.html?hub=${shot.scene}&page=${shot.page}`;
    await page.call("Page.navigate", { url });
    const found = await until(
      () =>
        page.evaluate(`document.readyState === "complete" && !!document.querySelector("main h1")`),
      `${shot.file} to render`,
    ).catch(() => false);
    if (!found) {
      problems.push(`${shot.file}: the page never rendered`);
      continue;
    }
    await page.evaluate(
      `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
    );
    const measured = await page.evaluate(`(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
      const parts = [...document.querySelectorAll(${JSON.stringify(shot.clip)})].map((e) => e.getBoundingClientRect());
      const card = document.querySelector("main").getBoundingClientRect();
      const clip = parts.length === 0 ? null : {
        left: Math.max(card.left, Math.min(...parts.map((r) => r.left))),
        top: Math.max(card.top, Math.min(...parts.map((r) => r.top))),
        right: Math.min(card.right, Math.max(...parts.map((r) => r.right))),
        bottom: Math.min(card.bottom, Math.max(...parts.map((r) => r.bottom))),
      };
      return { clip, callouts: ${JSON.stringify(shot.callouts.map((c) => c.target))}.map(rect) };
    })()`);
    if (!measured.clip) {
      problems.push(`${shot.file}: clip ${shot.clip} matches nothing`);
      continue;
    }
    const left = Math.max(0, measured.clip.left - pad);
    const top = Math.max(0, measured.clip.top - pad);
    const clip = {
      x: left,
      y: top,
      width: Math.min(viewport.width, measured.clip.right + pad) - left,
      height: Math.min(viewport.height, measured.clip.bottom + pad) - top,
    };
    const callouts = measured.callouts.map((r, index) => {
      if (!r) {
        problems.push(`${shot.file}: callout ${shot.callouts[index].target} matches nothing`);
        return { x: 0, y: 0 };
      }
      // Pins sit on a corner so they never cover what they point at: the top-left of a large area,
      // the top-right of a small control.
      const large = r.width > 80 && r.height > 80;
      return {
        x: round(((large ? r.x : r.x + r.width) - clip.x) / clip.width),
        y: round((r.y - clip.y) / clip.height),
      };
    });
    const outOfFrame = callouts.some(({ x, y }) => x < 0 || x > 1 || y < 0 || y > 1);
    if (outOfFrame) problems.push(`${shot.file}: a callout falls outside the clip`);
    layouts[shot.file] = {
      width: Math.round(clip.width),
      height: Math.round(clip.height),
      callouts,
    };
    if (!check) {
      const { data } = await page.call("Page.captureScreenshot", {
        format: "png",
        clip: { ...clip, scale: 1 },
      });
      writeFileSync(join(helpDir, "shots", `${shot.file}.png`), Buffer.from(data, "base64"));
    } else if (!existsSync(join(helpDir, "shots", `${shot.file}.png`))) {
      problems.push(`${shot.file}: no captured image; run node scripts/help-shots.mjs`);
    }
  }
  page.close();
} finally {
  stop();
}

const manifest = join(helpDir, "shots.ts");
const serialized = `// Generated by scripts/help-shots.mjs from the preview harness. Do not edit.
import type { ShotLayout } from "./types.ts";

export const shotLayouts: Partial<Record<string, ShotLayout>> = ${JSON.stringify(layouts, null, 2)};
`;
if (check) {
  const { shotLayouts } = await import(manifest);
  if (JSON.stringify(shotLayouts) !== JSON.stringify(layouts))
    problems.push("shots.ts is stale; run node scripts/help-shots.mjs");
} else {
  writeFileSync(manifest, serialized);
}
for (const problem of problems) console.error(problem);
console.log(
  `${check ? "checked" : "captured"} ${shots.length} help shots, ${problems.length} problems`,
);
process.exit(problems.length ? 1 : 0);

function topicsShots() {
  return Object.values(helpTopics).flatMap((topic) =>
    topic.sections.flatMap((section) => (section.shot ? [section.shot] : [])),
  );
}
