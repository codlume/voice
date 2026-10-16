import { useRef, useState } from "react";

import { actionErrorMessage } from "./actionError.ts";

/**
 * Runs main-process actions. Each run starts a new attempt and clears the last error; only the
 * newest attempt's outcome sets `pending` and `error`, so a slow earlier attempt cannot overwrite it.
 */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(0);

  async function run(action: () => Promise<void>, fallback: string): Promise<boolean> {
    const id = ++latest.current;
    setError("");
    setPending(true);
    try {
      await action();
      return true;
    } catch (caught) {
      if (id === latest.current) setError(actionErrorMessage(caught, fallback));
      return false;
    } finally {
      if (id === latest.current) setPending(false);
    }
  }

  return { pending, error, run, clearError: () => setError("") };
}
