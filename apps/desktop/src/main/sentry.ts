// Built as its own dist-electron/sentry.cjs so main loads the SDK only when diagnostics are on.
// Bundled into main.cjs, it added about 30 ms to every launch, sharing or not.
export {
  captureMessage,
  init,
  makeElectronTransport as makeTransport,
  setMeasurement,
  startInactiveSpan,
} from "@sentry/electron/main";
