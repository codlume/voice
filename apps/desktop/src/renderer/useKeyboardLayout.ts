import { useEffect, useState } from "react";

import type { KeyboardLayout } from "./shortcutCapture.ts";

declare global {
  interface Navigator {
    // Chromium's Keyboard Map API, which TypeScript's DOM types leave out.
    readonly keyboard?: { getLayoutMap(): Promise<KeyboardLayout> };
  }
}

export function useKeyboardLayout(): KeyboardLayout | null {
  const [layout, setLayout] = useState<KeyboardLayout | null>(null);
  useEffect(() => {
    let current = true;
    const read = () => {
      navigator.keyboard?.getLayoutMap().then(
        (map) => {
          if (current) setLayout(map);
        },
        () => {
          if (current) setLayout(null);
        },
      );
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      current = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return layout;
}
