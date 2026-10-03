import { useState } from "react";

import { actionErrorMessage } from "./actionError.ts";

/** One in-flight main-process action at a time, with its error shown until the next attempt. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<void>, fallback: string) {
    setError("");
    setPending(true);
    try {
      await action();
    } catch (caught) {
      setError(actionErrorMessage(caught, fallback));
    } finally {
      setPending(false);
    }
  }

  return { pending, error, run, clearError: () => setError("") };
}
