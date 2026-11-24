import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import { windowBackground } from "./window-background.ts";

const tokens = readFileSync(new URL("../renderer/tokens.stylex.ts", import.meta.url), "utf8");

// The light and dark values of a token written as `name: { default: "…", [dark]: "…" }` or
// `const name = { default: "…", [dark]: "…" }`.
function token(name: string) {
  const pattern = new RegExp(
    `\\b${name}(?::| =) \\{ default: "([^"]+)", \\[dark\\]: "([^"]+)" \\}`,
  );
  const [, light, dark] = pattern.exec(tokens) ?? [];
  if (!light || !dark) throw new Error(`no literal light and dark values for ${name}`);
  return { light: toHex(light), dark: toHex(dark) };
}

// Achromatic oklch to sRGB hex: with no chroma, every channel is the cube of the lightness.
function toHex(value: string) {
  if (value === "#000") return "#000000";
  if (value.startsWith("#")) return value;
  const match = /^oklch\(([\d.]+)% 0 0\)$/.exec(value);
  if (!match) throw new Error(`cannot convert ${value}; use a grey or a hex value`);
  const linear = (Number(match[1]) / 100) ** 3;
  const srgb = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  return `#${Math.round(srgb * 255)
    .toString(16)
    .padStart(2, "0")
    .repeat(3)}`;
}

test("the hub window paints the sidebar color", () => {
  expect(windowBackground.hub).toEqual(token("sidebar"));
});

test("the notepad window paints the page background", () => {
  expect(windowBackground.notepad).toEqual(token("background"));
});
