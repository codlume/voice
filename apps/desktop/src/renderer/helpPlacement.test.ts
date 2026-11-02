import { describe, expect, it } from "vite-plus/test";

import { placeHelp, roomAbove, type Box } from "./helpPlacement.ts";

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

const size = { width: 288, height: 260 };
const button: Box = { left: 300, top: 60, width: 24, height: 24 };

describe("placeHelp", () => {
  it("sits under the info button when nothing is highlighted", () => {
    expect(placeHelp({ view: { width: 1280, height: 800 }, button, target: null, size })).toEqual({
      x: 300,
      y: 92,
      clear: true,
    });
  });

  it("moves off a control right under the info button", () => {
    const target: Box = { left: 280, top: 100, width: 600, height: 40 };
    const at = placeHelp({ view: { width: 1280, height: 800 }, button, target, size });
    expect(overlaps({ left: at.x, top: at.y, ...size }, target)).toBe(false);
  });

  it("makes room above a card too tall to leave space around it", () => {
    const view = { width: 720, height: 480 };
    const card: Box = { left: 245, top: 139, width: 418, height: 332 };
    const small = { width: 288, height: 127 };
    const offIcon: Box = { ...button, top: -500 };
    expect(placeHelp({ view, button: offIcon, target: card, size: small }).clear).toBe(false);
    const dy = roomAbove({ target: card, size: small });
    const scrolled = { ...card, top: card.top - dy };
    const at = placeHelp({
      view,
      button: { ...offIcon, top: offIcon.top - dy },
      target: scrolled,
      size: small,
    });
    expect(at.clear).toBe(true);
    expect(scrolled.top).toBeGreaterThanOrEqual(0);
  });

  for (const view of [
    { width: 1280, height: 800 },
    { width: 720, height: 480 },
  ]) {
    it(`stays inside a ${view.width}×${view.height} window and off the control whenever any spot is free`, () => {
      const next = random(view.width);
      let checked = 0;
      for (let run = 0; run < 2000; run++) {
        const width = 20 + next() * (view.width / 2);
        const height = 20 + next() * (view.height / 3);
        const target: Box = {
          left: next() * (view.width - width),
          top: next() * (view.height - height),
          width,
          height,
        };
        const at = placeHelp({ view, button, target, size });
        expect(at.x).toBeGreaterThanOrEqual(0);
        expect(at.y).toBeGreaterThanOrEqual(0);
        expect(at.x + size.width).toBeLessThanOrEqual(view.width);
        expect(at.y + size.height).toBeLessThanOrEqual(view.height);
        const ring = { ...target, left: target.left - 6, top: target.top - 6 };
        const clear = { ...ring, width: target.width + 12, height: target.height + 12 };
        let free = false;
        for (let x = 8; x <= view.width - 8 - size.width && !free; x += 4)
          for (let y = 8; y <= view.height - 8 - size.height && !free; y += 4)
            free = !overlaps({ left: x, top: y, ...size }, clear);
        expect(at.clear).toBe(free);
        if (!free) continue;
        checked++;
        expect(overlaps({ left: at.x, top: at.y, ...size }, clear), JSON.stringify(target)).toBe(
          false,
        );
      }
      expect(checked).toBeGreaterThan(500);
    });
  }
});
