import { useEffect, useMemo, useState } from "react";

import type { MeetingControls } from "../shared/api.ts";
import {
  applyMeetingsChange,
  type Meeting,
  type MeetingId,
  type MeetingSource,
  type MeetingsState,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { mergeTranscript } from "./meetingsView.ts";
import { hubApi } from "./voice.ts";

/** Null until the first list arrives. */
export function useMeetings(): MeetingsState | null {
  const [state, setState] = useState<MeetingsState | null>(null);
  useEffect(() => {
    // As in useHistory: changes and the answer arrive in order, so the answer never replaces a
    // list a change built.
    const unsubscribe = hubApi().onMeetings((change) =>
      setState((current) => applyMeetingsChange(current, change)),
    );
    void hubApi()
      .getMeetings()
      .then((first) => setState((current) => current ?? first));
    return unsubscribe;
  }, []);
  return state;
}

/**
 * The meeting's transcript, grown by the lines main pushes while it records. Main rewrites the
 * file only when a pass over the recording ends, which always moves the status on, so the file
 * is read again on a status change and never for edits like notes or names. A line pushed while
 * a read is out is kept and merged in, since main may have read the file before writing it.
 * Until a read lands the last one stays; undefined before the first read of this meeting, null
 * once the meeting is gone.
 */
export function useMeetingTranscript(
  api: Pick<MeetingControls, "getMeeting" | "onMeetingTranscript">,
  meeting: Meeting | null,
): readonly TranscriptEntry[] | null | undefined {
  const [lines, setLines] = useState<{
    id: MeetingId;
    read: readonly TranscriptEntry[] | null;
    live: readonly TranscriptEntry[];
  } | null>(null);
  const id = meeting?.id ?? null;
  const step = meeting?.status.kind;
  useEffect(() => {
    if (!id) return;
    let current = true;
    // Lines pushed after this read was asked for; the lines pushed before it belong to the last one.
    let pending: TranscriptEntry[] | null = [];
    const unsubscribe = api.onMeetingTranscript((change) => {
      if (change.id !== id) return;
      if (pending) pending.push(...change.entries);
      else setLines((was) => was && { ...was, live: [...was.live, ...change.entries] });
    });
    void api.getMeeting(id).then((detail) => {
      if (!current || !pending) return;
      const live = pending;
      pending = null;
      setLines({ id, read: detail?.transcript ?? null, live });
    });
    return () => {
      current = false;
      unsubscribe();
    };
    // The status is not read here: its change is the signal that the file was rewritten.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [api, id, step]);
  return useMemo(() => {
    if (!id) return null;
    if (lines?.id !== id) return undefined;
    return lines.read && mergeTranscript(lines.read, lines.live);
  }, [id, lines]);
}

/** Each source's unconfirmed text while the meeting records; never saved, gone once it stops. */
export function useMeetingPartials(
  api: Pick<MeetingControls, "onMeetingPartial">,
  id: MeetingId,
  recording: boolean,
): Partial<Record<MeetingSource, string>> {
  const [partials, setPartials] = useState<Partial<Record<MeetingSource, string>>>({});
  useEffect(() => {
    if (!recording) return;
    const unsubscribe = api.onMeetingPartial((partial) => {
      if (partial.id !== id) return;
      setPartials((current) => ({ ...current, [partial.source]: partial.text }));
    });
    return () => {
      unsubscribe();
      setPartials({});
    };
  }, [api, id, recording]);
  return recording ? partials : {};
}
