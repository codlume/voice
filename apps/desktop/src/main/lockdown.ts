import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

export type Page = "hub" | "pill";

interface PageSource {
  development: boolean;
  env: { VITE_DEV_SERVER_URL?: string };
  rendererDir: string;
}

// Any same-user process can set VITE_DEV_SERVER_URL for the whole login session, and Voice is a
// login item, so only a development run reads it. A packaged app shows its bundled pages only.
export function pageUrl(page: Page, { development, env, rendererDir }: PageSource): string {
  const devServerUrl = development ? env.VITE_DEV_SERVER_URL : undefined;
  if (devServerUrl) return new URL(`${page}.html`, devServerUrl).href;
  return pathToFileURL(NodePath.join(rendererDir, `${page}.html`)).href;
}

// The slice of WebContents the guard touches, so tests can pass a plain object.
interface Lockable {
  getURL(): string;
  on(
    event: "will-navigate",
    listener: (event: { preventDefault(): void; url: string }) => void,
  ): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

// A window only ever shows the page main loaded into it. Vite's full reload in development
// re-requests that same URL, which is the one renderer-started navigation that stays allowed.
// External links open through main-process handlers that call shell.openExternal.
export function lockNavigation(contents: Lockable) {
  contents.on("will-navigate", (event) => {
    if (event.url !== contents.getURL()) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

interface PermissionSession {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}

// Capture runs in the helper and every other OS surface goes through main, so no page needs a web
// permission. Without a handler Electron grants media and notifications to any page that asks.
export function denyPermissions(session: PermissionSession) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
