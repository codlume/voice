import { createContext, useContext, useEffect } from "react";

/**
 * Main can ask the shell to show another page with no user action, as when a meeting summary is
 * ready. A page holds that request while the user has unsaved work open, so the page and the work
 * are not unmounted; the shell applies it when the last hold ends.
 */
export const NavigationHold = createContext<() => () => void>(() => () => {});

export function useHoldNavigation(holding: boolean) {
  const hold = useContext(NavigationHold);
  useEffect(() => (holding ? hold() : undefined), [holding, hold]);
}
