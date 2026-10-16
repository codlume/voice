// Runs the landing page's inline script against a stub DOM, for the API's own tests and the
// desktop's cross-app test. The workerd tests cannot execute it, because Workers forbid eval.
import { runInNewContext } from "node:vm";
import { landingPage } from "../src/landing.ts";

const script = landingPage.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

type Device = {
  platform?: string;
  userAgentData?: { platform: string };
  maxTouchPoints?: number;
};

type PageCall = { fetch: string; init: unknown } | { replace: string } | { copy: string };

export function openLanding(
  cookie: string,
  {
    clipboard = () => Promise.resolve(),
    hash = "",
    platform = "MacIntel",
    userAgentData,
    maxTouchPoints = 0,
  }: Device & { clipboard?: () => Promise<void>; hash?: string } = {},
) {
  const listeners: Record<string, () => void> = {};
  const views = Object.fromEntries(
    [...landingPage.matchAll(/<main id="([^"]+)" hidden>/g)].map(([, id]) => [
      id,
      { hidden: true },
    ]),
  );
  const elements = {
    ...views,
    open: { href: "" },
    code: { textContent: "" },
    copy: {
      textContent: "Copy",
      addEventListener: (type: string, listener: () => void) => (listeners[type] = listener),
    },
  };
  const calls: PageCall[] = [];
  const selected: unknown[] = [];
  runInNewContext(script, {
    document: { cookie, getElementById: (id: string) => elements[id] },
    navigator: {
      clipboard: { writeText: (text: string) => (calls.push({ copy: text }), clipboard()) },
      platform,
      userAgentData,
      maxTouchPoints,
    },
    getSelection: () => ({ selectAllChildren: (node: unknown) => selected.push(node) }),
    fetch: (url: string, init: unknown) => {
      // The init object comes from the page's realm, so copy it before comparing.
      calls.push({ fetch: url, init: structuredClone(init) });
      return Promise.resolve(new Response());
    },
    location: { hash, replace: (url: string) => calls.push({ replace: url }) },
  });
  const clickCopy = async () => {
    listeners.click?.();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { elements, calls, selected, clickCopy };
}
