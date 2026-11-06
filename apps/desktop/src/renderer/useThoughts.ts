import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Meeting } from "../shared/meetings.ts";
import { useAction } from "./useAction.ts";

const SAVE_DELAY_MS = 600;

/**
 * "My thoughts" for one meeting, shared by the Voice window and the notepad. Typing is saved after
 * a pause, when the view goes away and when the window closes; text stays unsaved until main
 * confirms it, so a failed save can be retried. Main's copy shows whenever it holds what was
 * typed, so an edit made in the other window appears here too; while the user types here, theirs
 * wins, and the last save wins in main.
 */
export function useThoughts(meeting: Meeting, save: (notes: string) => Promise<void>) {
  const [draft, setDraft] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const unsaved = useRef<string | null>(null);
  const action = useAction();
  const flush = useEffectEvent(() => {
    const notes = unsaved.current;
    if (notes === null) {
      action.clearError();
      return;
    }
    setSent(notes);
    void action.run(async () => {
      try {
        await save(notes);
      } catch (error) {
        setSent((current) => (current === notes ? null : current));
        throw error;
      }
      if (unsaved.current === notes) unsaved.current = null;
    }, "Could not save your thoughts.");
  });
  const held = useEffectEvent(() => meeting.notes);
  useEffect(() => {
    if (draft === null) {
      if (unsaved.current === held()) unsaved.current = null;
      return;
    }
    if (unsaved.current !== draft) return;
    const timer = setTimeout(flush, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  // React never unmounts a closing window's root, so leaving saves on unmount and on
  // beforeunload. Not pagehide: a closing window's IPC sent then reaches main after the window's
  // handlers are gone, and the save is lost.
  useEffect(() => {
    const leave = () => flush();
    window.addEventListener("beforeunload", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      leave();
    };
  }, []);
  if (sent !== null && sent === meeting.notes) setSent(null);
  if (draft !== null && draft === meeting.notes && sent === null) setDraft(null);
  return {
    text: draft ?? meeting.notes,
    change(text: string) {
      unsaved.current = text;
      setDraft(text);
    },
    error: action.error,
    pending: action.pending,
    retry: flush,
  };
}
