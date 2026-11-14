// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";

import type { Shortcut } from "../shared/transforms.ts";
import { ShortcutPicker } from "./ShortcutPicker.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const controlOptionM: Shortcut = { keycode: 46, modifiers: ["control", "option"] };

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

function mount(saved: Shortcut | null) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(saved);
    return (
      <ShortcutPicker
        value={value}
        others={[]}
        layout={null}
        dictationKeys={["fn"]}
        invalid={false}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<Harness />));
  const picker = host.querySelector<HTMLButtonElement>("button[aria-describedby]");
  if (picker === null) throw new Error("no picker");
  return { picker, onChange };
}

/** Dispatches a keydown and reports whether the picker let the browser act on it. */
const press = (target: Element, init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return !event.defaultPrevented;
};
const recording = (picker: HTMLButtonElement) => picker.textContent === "Type a shortcut";

test("focus alone does not start recording, so a later key press keeps the saved shortcut", () => {
  const { picker, onChange } = mount(controlOptionM);
  // Tab in, or the window losing and regaining focus, which blurs and refocuses the picker.
  act(() => picker.focus());
  act(() => picker.blur());
  act(() => picker.focus());
  expect(recording(picker)).toBe(false);
  // Command+2 jumps to another Settings page.
  expect(press(picker, { key: "2", code: "Digit2", metaKey: true })).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

test("a click starts recording, and the next shortcut is saved once", () => {
  const { picker, onChange } = mount(null);
  act(() => picker.focus());
  act(() => picker.click());
  expect(recording(picker)).toBe(true);
  press(picker, { key: "m", code: "KeyM", ctrlKey: true, altKey: true });
  expect(onChange).toHaveBeenCalledExactlyOnceWith(controlOptionM);
  expect(recording(picker)).toBe(false);
});

test("Space or Enter on the focused picker starts recording", () => {
  for (const key of [" ", "Enter"]) {
    const { picker } = mount(controlOptionM);
    act(() => picker.focus());
    // The browser turns an unprevented Space or Enter on a button into a click.
    expect(press(picker, { key, code: key === " " ? "Space" : "Enter" })).toBe(true);
    act(() => picker.click());
    expect(recording(picker)).toBe(true);
    act(() => root?.unmount());
    document.body.replaceChildren();
  }
});
