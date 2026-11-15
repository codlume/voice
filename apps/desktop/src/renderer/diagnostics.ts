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
      enableLogs: false,
      integrations: (defaults) => defaults.filter(({ name }) => INTEGRATIONS.has(name)),
    }),
  );
}
