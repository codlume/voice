import type { DictationOptions } from "../dictation.ts";

/** For dictation tests that do not exercise auto-apply: no transform model on disk. */
export const noAutoApply: DictationOptions["transform"] = {
  model: {
    run: () => Promise.reject(new Error("The transform model is not installed")),
    warm: () => {},
    onDisk: () => false,
  },
  remember: () => {},
};
