import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Meeting } from "../shared/meetings.ts";
import { useAction } from "./useAction.ts";

const SAVE_DELAY_MS = 600;

/**
 * "My thoughts" for one meeting, shared by the Voice window and the notepad. Typing is saved after
 * a pause and when the view goes away. Main's copy shows whenever it holds what was typed, so
 * an edit made in the other window appears here too; while the user types here, theirs wins.
 */
export function useThoughts(
  meeting: Meeting,
  save: (notes: string) => Promise<void>,
  failure: string,
) {
  const [draft, setDraft] = useState<string | null>(null);
  const unsaved = useRef<string | null>(null);
  const action = useAction();
  const flush = useEffectEvent(() => {
    const notes = unsaved.current;
    if (notes === null) return;
    unsaved.current = null;
    void action.run(() => save(notes), failure);
  });
  useEffect(() => {
    if (draft === null || unsaved.current !== draft) return;
    const timer = setTimeout(flush, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  // Leaving saves what the delay has not yet sent.
  useEffect(() => () => flush(), []);
  if (draft !== null && draft === meeting.notes) setDraft(null);
  return {
    text: draft ?? meeting.notes,
    change(text: string) {
      unsaved.current = text;
      setDraft(text);
    },
    error: action.error,
  };
}
