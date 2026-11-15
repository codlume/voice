import type { DictationOptions } from "../dictation.ts";

export const noAutoApply: DictationOptions["transform"] = {
  model: {
    run: () => Promise.reject(new Error("The transform model is not installed")),
    warm: () => {},
    onDisk: () => false,
  },
  remember: () => {},
};
