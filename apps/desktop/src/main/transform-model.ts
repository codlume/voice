// The transform model's lifecycle in main: install, find, load on use, idle unload, status.
// The body lands with the engine; these are the types the orchestration builds against.

export type TransformFailure =
  | { kind: "tooLong"; maxWords: number }
  | { kind: "timedOut" }
  // The guard refused the model's output.
  | { kind: "rejected" };

export type TransformResult = { ok: true; text: string } | { ok: false; failure: TransformFailure };

export type TransformRequest = {
  instruction: string;
  text: string;
  /** Adds the dictation line to the prompt, so dictated commands stay words. */
  dictation: boolean;
  budgetMs: number;
  signal: AbortSignal;
};

/**
 * `run` resolves with data for every failure the text caused and rejects only on abort
 * (`signal.reason`), a model that is not installed, a load failure or a lost process.
 */
export type TransformModel = {
  /** Launch check: finds weights on disk and reports installed or missing. Never loads. */
  refresh(): Promise<void>;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  run(request: TransformRequest): Promise<TransformResult>;
  /** Fire and forget. Starts a load if the weights are on disk. Safe to call on every press. */
  warm(): void;
  onDisk(): boolean;
  dispose(): Promise<void>;
};
