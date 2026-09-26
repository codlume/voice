import { nativeImage, type NativeImage } from "electron";

// Waveform with a text cursor ("GlyphOpen", idle) on a 36-unit grid: [x, y, width, height].
const GRID = 36;
const RADIUS = 1.5;
const RECTS = [
  [2, 13, 3, 10],
  [8, 9, 3, 18],
  [25, 9, 3, 18],
  [31, 13, 3, 10],
  [16.5, 4, 3, 28],
  [14, 4, 8, 3],
  [14, 29, 8, 3],
] as const;

function insideGlyph(x: number, y: number): boolean {
  const gx = x * GRID;
  const gy = y * GRID;
  return RECTS.some(([rx, ry, w, h]) => {
    const dx = Math.max(rx + RADIUS - gx, 0, gx - (rx + w - RADIUS));
    const dy = Math.max(ry + RADIUS - gy, 0, gy - (ry + h - RADIUS));
    return gx >= rx && gx <= rx + w && gy >= ry && gy <= ry + h && Math.hypot(dx, dy) <= RADIUS;
  });
}

function rasterize(size: number): Buffer {
  const samples = 4;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          if (insideGlyph(x, y)) covered += 1;
        }
      }
      pixels[(py * size + px) * 4 + 3] = Math.round((255 * covered) / (samples * samples));
    }
  }
  return pixels;
}

export function createTrayIcon(): NativeImage {
  const image = nativeImage.createFromBitmap(rasterize(18), { width: 18, height: 18 });
  image.addRepresentation({ scaleFactor: 2, width: 36, height: 36, buffer: rasterize(36) });
  image.setTemplateImage(true);
  return image;
}
