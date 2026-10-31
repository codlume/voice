import { useEffect, useState } from "react";

import type { MeetingControls } from "../shared/api.ts";
import {
  applyMeetingsChange,
  type Meeting,
  type MeetingDetail,
  type MeetingId,
  type MeetingSource,
  type MeetingsState,
} from "../shared/meetings.ts";
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
 * The meeting with its transcript, read again whenever main publishes a new version of the meeting,
 * and grown by the lines main pushes while it records. Undefined while loading, null once the
 * meeting is gone.
 */
export function useMeetingDetail(meeting: Meeting | null): MeetingDetail | null | undefined {
  const [loaded, setLoaded] = useState<{ for: Meeting; detail: MeetingDetail | null } | null>(null);
  useEffect(() => {
    if (!meeting) return;
    let current = true;
    // Lines pushed before the read lands are already in it, and a line is never pushed twice.
    let read = false;
    const unsubscribe = hubApi().onMeetingTranscript(({ id, entries }) => {
      if (!current || !read || id !== meeting.id) return;
      setLoaded((last) =>
        last?.detail
          ? {
              ...last,
              detail: { ...last.detail, transcript: [...last.detail.transcript, ...entries] },
            }
          : last,
      );
    });
    void hubApi()
      .getMeeting(meeting.id)
      .then((detail) => {
        if (!current) return;
        read = true;
        setLoaded({ for: meeting, detail });
      });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [meeting]);
  if (!meeting) return null;
  // A newer version of the same meeting keeps showing the last transcript until its read lands.
  return loaded?.for.id === meeting.id ? loaded.detail && { ...loaded.detail, meeting } : undefined;
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
