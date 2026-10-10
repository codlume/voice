import { describe, expect, test } from "vite-plus/test";

import { denyPermissions, lockNavigation, pageUrl } from "./lockdown.ts";

const rendererDir = "/Applications/Voice.app/Contents/Resources/app.asar/dist/renderer";
const env = { VITE_DEV_SERVER_URL: "https://attacker.example/" };

describe("pageUrl", () => {
  test("a development run loads from the dev server", () => {
    expect(pageUrl("hub", { development: true, env, rendererDir })).toBe(
      "https://attacker.example/hub.html",
    );
  });

  test("a packaged app ignores VITE_DEV_SERVER_URL and loads its bundled page", () => {
    expect(pageUrl("pill", { development: false, env, rendererDir })).toBe(
      `file://${rendererDir}/pill.html`,
    );
  });
});

// web-contents-created fires before the first load, so the lock sees an empty URL. The page URL
// is set afterwards, as in production, so a URL captured at lock time would block every reload.
function lockedWindow() {
  const page = { url: "" };
  let onNavigate: ((event: { preventDefault(): void; url: string }) => void) | undefined;
  let onOpen: (() => { action: string }) | undefined;
  lockNavigation({
    getURL: () => page.url,
    on: (_event, listener) => (onNavigate = listener),
    setWindowOpenHandler: (handler) => (onOpen = handler),
  });
  page.url = "file:///Voice/hub.html";
  return {
    navigate(target: string) {
      let prevented = false;
      onNavigate?.({ url: target, preventDefault: () => (prevented = true) });
      return prevented ? "blocked" : "allowed";
    },
    open: () => onOpen?.().action ?? "allow",
  };
}

describe("lockNavigation", () => {
  test("blocks a window from navigating to another page", () => {
    expect(lockedWindow().navigate("https://example.com/")).toBe("blocked");
    expect(lockedWindow().navigate("file:///Voice/pill.html")).toBe("blocked");
  });

  test("lets a page reload itself", () => {
    expect(lockedWindow().navigate("file:///Voice/hub.html")).toBe("allowed");
  });

  test("denies new windows", () => {
    expect(lockedWindow().open()).toBe("deny");
  });
});

type RequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
) => void;

describe("denyPermissions", () => {
  test("refuses every permission request and check", () => {
    const handlers: { request?: RequestHandler; check?: () => boolean } = {};
    denyPermissions({
      setPermissionRequestHandler: (handler) => (handlers.request = handler),
      setPermissionCheckHandler: (handler) => (handlers.check = handler),
    });
    const answers: boolean[] = [];
    handlers.request?.({}, "media", (granted) => answers.push(granted));
    handlers.request?.({}, "notifications", (granted) => answers.push(granted));
    expect(answers).toEqual([false, false]);
    expect(handlers.check?.()).toBe(false);
  });
});
