export type Box = { left: number; top: number; width: number; height: number };
export type Point = { x: number; y: number };

const margin = 8;
const gap = 8;
/** Room kept around the control for its outline ring. */
const ringRoom = 6;

const right = (box: Box) => box.left + box.width;
const bottom = (box: Box) => box.top + box.height;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

function overlap(a: Box, b: Box): number {
  const x = Math.min(right(a), right(b)) - Math.max(a.left, b.left);
  const y = Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top);
  return x > 0 && y > 0 ? x * y : 0;
}

const grow = (box: Box, by: number): Box => ({
  left: box.left - by,
  top: box.top - by,
  width: box.width + 2 * by,
  height: box.height + 2 * by,
});

/** The four spots beside `around`, start-aligned first, in the order the help prefers them. */
function beside(around: Box, size: { width: number; height: number }): Point[] {
  return [
    { x: around.left, y: bottom(around) + gap },
    { x: right(around) - size.width, y: bottom(around) + gap },
    { x: right(around) + gap, y: around.top },
    { x: around.left - gap - size.width, y: around.top },
    { x: around.left, y: around.top - gap - size.height },
  ];
}

/**
 * Where the help popover's top-left corner goes: next to the info button when that leaves the
 * highlighted control in view, otherwise next to the control. Always inside the window. When
 * nothing fits, the spot that covers the least of the control.
 */
export function placeHelp({
  view,
  button,
  target,
  size,
}: {
  view: { width: number; height: number };
  button: Box;
  target: Box | null;
  size: { width: number; height: number };
}): Point {
  const fit = ({ x, y }: Point): Point => ({
    x: clamp(x, margin, view.width - margin - size.width),
    y: clamp(y, margin, view.height - margin - size.height),
  });
  const spots = [...beside(button, size), ...(target ? beside(grow(target, ringRoom), size) : [])];
  const placed = spots.map(fit);
  if (!target) return placed[0]!;
  const keepClear = grow(target, ringRoom);
  const covers = (point: Point) => overlap({ left: point.x, top: point.y, ...size }, keepClear);
  return placed.find((point) => covers(point) === 0) ?? minBy(placed, covers);
}

function minBy<T>(items: readonly T[], score: (item: T) => number): T {
  return items.reduce((best, item) => (score(item) < score(best) ? item : best));
}
