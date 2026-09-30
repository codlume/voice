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

export function startRendererDiagnostics() {
  if (!window.voice.diagnosticsStartedAtLaunch) return;
  void import("@sentry/electron/renderer").then((Sentry) =>
    Sentry.init({
      sendDefaultPii: false,
      integrations: (defaults) => defaults.filter(({ name }) => INTEGRATIONS.has(name)),
    }),
  );
}
