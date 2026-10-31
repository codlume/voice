import { useEffect, useState } from "react";

import {
  applyMeetingsChange,
  type Meeting,
  type MeetingDetail,
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
 * The meeting with its transcript, read again whenever main publishes a new version of the meeting.
 * Undefined while loading, null once the meeting is gone.
 */
export function useMeetingDetail(meeting: Meeting | null): MeetingDetail | null | undefined {
  const [loaded, setLoaded] = useState<{ for: Meeting; detail: MeetingDetail | null } | null>(null);
  useEffect(() => {
    if (!meeting) return;
    let current = true;
    void hubApi()
      .getMeeting(meeting.id)
      .then((detail) => {
        if (current) setLoaded({ for: meeting, detail });
      });
    return () => {
      current = false;
    };
  }, [meeting]);
  if (!meeting) return null;
  // A newer version of the same meeting keeps showing the last transcript until its read lands.
  return loaded?.for.id === meeting.id ? loaded.detail && { ...loaded.detail, meeting } : undefined;
}
