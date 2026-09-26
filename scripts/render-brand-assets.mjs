import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";
import { parse } from "yaml";

const desktopDir = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
// Mirrors font.serif in apps/desktop/src/renderer/tokens.stylex.ts.
const serif = "ui-serif, 'New York', 'Iowan Old Style', Charter, Georgia, serif";
const width = 660;
const arrowGap = 35;
const minArrowLength = 40;
const renderTimeoutMs = 15_000;
// Measured on macOS 27, Finder uses the 1x image size as the window frame, 32pt title bar included,
// and top-anchors the image. The 28pt title bar on macOS 15 and earlier is assumed, so those systems
// show about 4pt of extra paper at the bottom.
const maxTitleBar = 32;
const height = 400 + maxTitleBar;

function fail(problem) {
  throw new Error(`electron-builder.yml: ${problem}`);
}

function readLayout() {
  const { dmg } = parse(readFileSync(resolve(desktopDir, "electron-builder.yml"), "utf8")) ?? {};
  if (!dmg?.background) fail("dmg.background is missing");
  const files = dmg.contents?.filter((item) => item.type === "file") ?? [];
  const links = dmg.contents?.filter((item) => item.type === "link") ?? [];
  if (files.length !== 1 || links.length !== 1) {
    fail(`dmg.contents needs one "file" and one "link", found ${files.length} and ${links.length}`);
  }
  const [source] = files;
  const [destination] = links;
  if (source.y !== destination.y) fail("dmg.contents file and link must share a row");
  const arrowStart = source.x + dmg.iconSize / 2 + arrowGap;
  const arrowTip = destination.x - dmg.iconSize / 2 - arrowGap;
  if (!(arrowTip - arrowStart >= minArrowLength)) {
    fail(`dmg.contents leaves no room for a ${minArrowLength}px arrow from file to link`);
  }
  return {
    background: resolve(desktopDir, dmg.background),
    row: source.y,
    arrowStart,
    arrowTip,
    hintTop: source.y + dmg.iconSize / 2 + 60,
  };
}

function backgroundPage({ row, arrowStart, arrowTip, hintTop }) {
  return `<!doctype html><body style="margin:0">
<div style="position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#F4F2EE;color:#24231F;font-family:${serif}">
  <svg width="${width}" height="${height}" style="position:absolute;left:0;top:0">
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
    <rect width="${width}" height="${height}" filter="url(#grain)" opacity="0.05"/>
    <path d="M${arrowStart} ${row} H${arrowTip - 2}" fill="none" stroke="#8F897F" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 9"/>
    <path d="M${arrowTip - 14} ${row - 13} L${arrowTip} ${row} L${arrowTip - 14} ${row + 13}" fill="none" stroke="#8F897F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <div style="position:absolute;left:0;top:28px;width:${width}px;text-align:center;font-size:28px;letter-spacing:-0.01em;line-height:1">Voice</div>
  <div style="position:absolute;left:0;top:${hintTop}px;width:${width}px;text-align:center;font-size:19px;line-height:1.2">Drag Voice into Applications</div>
</div></body>`;
}

async function render(page, { name, scale }) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { offscreen: { deviceScaleFactor: scale } },
  });
  await win.loadURL(`data:text/html;base64,${Buffer.from(page).toString("base64")}`);
  await win.webContents.executeJavaScript(
    "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
  );
  const png = (await win.webContents.capturePage()).toPNG();
  // offscreen.deviceScaleFactor is experimental, so check the PNG header for the real size.
  const size = png.length > 24 ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "empty";
  const expected = `${width * scale}x${height * scale}`;
  if (size !== expected) throw new Error(`${name} rendered ${size}, expected ${expected}`);
  return png;
}

async function renderWithTimeout(page, target) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${target.name} did not render within ${renderTimeoutMs / 1000}s`)),
      renderTimeoutMs,
    );
  });
  try {
    return await Promise.race([render(page, target), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

app
  .whenReady()
  .then(async () => {
    app.dock?.hide();
    const layout = readLayout();
    const page = backgroundPage(layout);
    // dmg-builder finds the retina background with this rewrite (transformBackgroundFileIfNeed).
    const targets = [1, 2].map((scale) => {
      const file =
        scale === 1 ? layout.background : layout.background.replace(/\.([a-z]+)$/, "@2x.$1");
      return { file, name: relative(desktopDir, file), scale };
    });
    const rendered = [];
    for (const target of targets) rendered.push([target, await renderWithTimeout(page, target)]);
    for (const [{ file, name }, png] of rendered) {
      writeFileSync(file, png);
      console.log(`wrote ${name}`);
    }
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
