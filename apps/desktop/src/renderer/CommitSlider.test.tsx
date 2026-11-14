// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { CommitSlider } from "./CommitSlider.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

/** A slider saved at 70 whose saves main has not answered yet. */
function mount() {
  const commits: number[] = [];
  const answers: ((ok: boolean) => void)[] = [];
  const onCommit = (value: number) => {
    commits.push(value);
    return new Promise<boolean>((resolve) => answers.push(resolve));
  };
  // Each snapshot from main renders the slider again with the saved value.
  const publish = (saved: number) =>
    root?.render(
      <CommitSlider
        saved={saved}
        onCommit={onCommit}
        min={10}
        max={100}
        step={10}
        readout={(value) => `${value}%`}
        label="Reduce volume by"
        valueText={(value) => `${value} percent`}
      />,
    );
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => publish(70));
  const thumb = host.querySelector<HTMLInputElement>('input[type="range"]');
  if (thumb === null) throw new Error("no slider thumb");
  const press = (key: "ArrowLeft" | "ArrowRight") =>
    act(() => {
      thumb.dispatchEvent(
        new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
      );
    });
  return {
    commits,
    press,
    shown: () => Number(thumb.getAttribute("aria-valuenow")),
    // Main applies the save and pushes its snapshot, then answers the commit.
    land: (value: number, ok = true) =>
      act(async () => {
        if (ok) publish(value);
        answers.shift()?.(ok);
      }),
  };
}

test("an older save landing under a newer pending commit does not move the thumb back", async () => {
  const slider = mount();
  slider.press("ArrowRight");
  slider.press("ArrowRight");
  expect(slider.commits).toEqual([80, 90]);

  await slider.land(80);
  expect(slider.shown()).toBe(90);
  slider.press("ArrowLeft");
  // Right, Right, Left from 70 is 80.
  expect(slider.commits.at(-1)).toBe(80);
});

test("a failed commit puts the thumb back on the saved value, and later saves still move it", async () => {
  const slider = mount();
  slider.press("ArrowRight");
  await slider.land(80, false);
  expect(slider.shown()).toBe(70);

  slider.press("ArrowRight");
  await slider.land(80);
  expect(slider.shown()).toBe(80);
});
