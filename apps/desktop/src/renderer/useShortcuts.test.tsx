// @vitest-environment happy-dom
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import { jumpShortcuts, shortcuts, useShortcuts } from "./shortcuts.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

async function mount(children: ReactNode, { reachAppModal = true } = {}): Promise<string[]> {
  const ran: string[] = [];
  function Shell() {
    useShortcuts(
      [shortcuts.toggleSidebar, shortcuts.openSettings, jumpShortcuts[0]!].map((shortcut) => ({
        shortcut,
        run: () => ran.push(shortcut.key),
      })),
      { reachAppModal },
    );
    return children;
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Shell />));
  return ran;
}

async function press(target: Element, key: string, code: string) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, code, metaKey: true, bubbles: true, cancelable: true }),
    );
  });
}

function field(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id}`);
  element.focus();
  return element;
}

test("shortcuts run while focus is on the page", async () => {
  const ran = await mount(<input id="page-field" />);
  const input = field("page-field");
  await press(input, "1", "Digit1");
  await press(input, ",", "Comma");
  await press(input, "b", "KeyB");
  expect(ran).toEqual(["1", ",", "b"]);
});

test("shortcuts do not run while focus is inside an open dialog", async () => {
  const ran = await mount(
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Popup>
          <input id="draft" defaultValue="unsaved snippet trigger" />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>,
  );
  const input = field("draft");
  await press(input, "1", "Digit1");
  await press(input, ",", "Comma");
  await press(input, "b", "KeyB");
  expect(ran).toEqual([]);
});

test("shortcuts do not run while focus is inside an open alert dialog", async () => {
  const ran = await mount(
    <AlertDialog.Root open>
      <AlertDialog.Portal>
        <AlertDialog.Popup>
          <button id="confirm" type="button">
            Delete
          </button>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>,
  );
  await press(field("confirm"), "1", "Digit1");
  expect(ran).toEqual([]);
});

function AppModal({ children }: { children?: ReactNode }) {
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Popup data-app-modal>
          <input id="setting" />
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

test("shortcuts run while focus is inside the app modal", async () => {
  const ran = await mount(<AppModal />);
  const input = field("setting");
  await press(input, "1", "Digit1");
  await press(input, ",", "Comma");
  expect(ran).toEqual(["1", ","]);
});

test("a page's shortcuts do not run inside the app modal", async () => {
  const ran = await mount(<AppModal />, { reachAppModal: false });
  await press(field("setting"), "1", "Digit1");
  expect(ran).toEqual([]);
});

test("shortcuts do not run inside a dialog nested in the app modal", async () => {
  const ran = await mount(
    <AppModal>
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Popup>
            <input id="nested-draft" />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </AppModal>,
  );
  await press(field("nested-draft"), ",", "Comma");
  expect(ran).toEqual([]);
});

test("shortcuts do not run inside an alert dialog nested in the app modal", async () => {
  const ran = await mount(
    <AppModal>
      <AlertDialog.Root open>
        <AlertDialog.Portal>
          <AlertDialog.Popup>
            <button id="nested-confirm" type="button">
              Clear
            </button>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </AppModal>,
  );
  await press(field("nested-confirm"), "1", "Digit1");
  expect(ran).toEqual([]);
});
