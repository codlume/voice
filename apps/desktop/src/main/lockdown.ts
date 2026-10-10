import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";

export type Page = "hub" | "pill";

interface PageSource {
  development: boolean;
  env: { VITE_DEV_SERVER_URL?: string };
  rendererDir: string;
}

export function pageUrl(page: Page, { development, env, rendererDir }: PageSource): string {
  const devServerUrl = development ? env.VITE_DEV_SERVER_URL : undefined;
  if (devServerUrl) return new URL(`${page}.html`, devServerUrl).href;
  return pathToFileURL(NodePath.join(rendererDir, `${page}.html`)).href;
}

interface Lockable {
  getURL(): string;
  on(
    event: "will-navigate",
    listener: (event: { preventDefault(): void; url: string }) => void,
  ): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

// Vite's full reload in development re-requests the window's own URL, the one navigation that
// stays allowed.
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

// Without a handler Electron grants media and notifications to any page that asks.
export function denyPermissions(session: PermissionSession) {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}
