import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { Meeting, MeetingId } from "../shared/meetings.ts";
import { actionErrorMessage } from "./actionError.ts";
import { useAction } from "./useAction.ts";

const SAVE_DELAY_MS = 600;
const SAVE_FAILED = "Could not save your thoughts.";

/**
 * Thoughts typed in this window that main has not confirmed, by meeting. They outlive the editor,
 * which a tab switch or leaving the meeting unmounts, and live in memory only. `error` is why
 * their last save failed. An editor that only shows such text again never sends it: the other
 * window may have saved newer notes since, so it waits for Try again or more typing.
 */
const unsaved = new Map<MeetingId, { text: string; error: string }>();

/**
 * "My thoughts" for one meeting, shared by the Voice window and the notepad. Typing is saved after
 * a pause, when the view goes away and when the window closes; text stays unsaved until main
 * confirms it, so a failed save can be retried, also after coming back to it. Main's copy shows
 * whenever it holds what was typed, so an edit made in the other window appears here too; while
 * the user types here, theirs wins, and the last save wins in main.
 */
export function useThoughts(meeting: Meeting, save: (notes: string) => Promise<void>) {
  const { id } = meeting;
  const [draft, setDraft] = useState(() => unsaved.get(id)?.text ?? null);
  // Left by an editor this one replaces.
  const [restoredError, setRestoredError] = useState(() => unsaved.get(id)?.error ?? "");
  const [sent, setSent] = useState<string | null>(null);
  const inFlight = useRef(0);
  const typedHere = useRef(false);
  const action = useAction();
  const flush = useEffectEvent(() => {
    setRestoredError("");
    const notes = unsaved.get(id)?.text;
    if (notes === undefined) {
      action.clearError();
      return;
    }
    unsaved.set(id, { text: notes, error: "" });
    setSent(notes);
    inFlight.current += 1;
    void action.run(async () => {
      try {
        await save(notes);
      } catch (error) {
        setSent((current) => (current === notes ? null : current));
        if (unsaved.get(id)?.text === notes) {
          unsaved.set(id, { text: notes, error: actionErrorMessage(error, SAVE_FAILED) });
        }
        throw error;
      } finally {
        inFlight.current -= 1;
      }
      if (unsaved.get(id)?.text === notes) unsaved.delete(id);
    }, SAVE_FAILED);
  });
  const held = useEffectEvent(() => meeting.notes);
  useEffect(() => {
    const waiting = unsaved.get(id);
    if (draft === null) {
      if (inFlight.current === 0 && waiting?.text === held()) unsaved.delete(id);
      return;
    }
    if (waiting?.text !== draft || waiting.error) return;
    const timer = setTimeout(flush, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [id, draft]);
  // React never unmounts a closing window's root, so leaving saves on unmount and on
  // beforeunload. Not pagehide: a closing window's IPC sent then reaches main after the window's
  // handlers are gone, and the save is lost.
  const leave = useEffectEvent(() => {
    if (typedHere.current || !unsaved.get(id)?.error) flush();
  });
  useEffect(() => {
    const leaving = () => leave();
    window.addEventListener("beforeunload", leaving);
    return () => {
      window.removeEventListener("beforeunload", leaving);
      leaving();
    };
  }, []);
  if (sent !== null && sent === meeting.notes) setSent(null);
  if (draft !== null && draft === meeting.notes && sent === null) setDraft(null);
  return {
    text: draft ?? meeting.notes,
    change(text: string) {
      typedHere.current = true;
      unsaved.set(id, { text, error: "" });
      setDraft(text);
    },
    error: action.error || restoredError,
    pending: action.pending,
    retry: flush,
  };
}
