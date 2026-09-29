import type { Snapshot } from "../shared/api.ts";

// Renderer errors travel to main over IPC and pass main's scrubber and consent gate. Only the
// handlers that catch errors are kept: no breadcrumbs, request context, or scope sync.
const INTEGRATIONS: ReadonlySet<string> = new Set([
  "InboundFilters",
  "FunctionToString",
  "BrowserApiErrors",
  "GlobalHandlers",
  "LinkedErrors",
  "Dedupe",
]);

let decided = false;

// Main starts Sentry only when consent was on at launch, so the first snapshot decides.
export function startRendererDiagnostics({ settings }: Snapshot) {
  if (decided) return;
  decided = true;
  if (settings.diagnostics !== "on") return;
  void import("@sentry/electron/renderer").then((Sentry) =>
    Sentry.init({
      sendDefaultPii: false,
      integrations: (defaults) => defaults.filter(({ name }) => INTEGRATIONS.has(name)),
    }),
  );
}
