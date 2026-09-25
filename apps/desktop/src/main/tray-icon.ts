import { nativeImage, type NativeImage } from "electron";

function insideGlyph(x: number, y: number): boolean {
  const dx = Math.abs(x - 0.5);
  const capsule =
    dx <= 0.15 &&
    y >= 0.06 &&
    y <= 0.56 &&
    (y >= 0.21 && y <= 0.41 ? true : Math.hypot(dx, y < 0.31 ? y - 0.21 : y - 0.41) <= 0.15);
  const ring = Math.hypot(dx, y - 0.41) >= 0.25 && Math.hypot(dx, y - 0.41) <= 0.31 && y >= 0.41;
  const stem = dx <= 0.035 && y >= 0.7 && y <= 0.86;
  const base = dx <= 0.17 && y >= 0.86 && y <= 0.93;
  return capsule || ring || stem || base;
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
