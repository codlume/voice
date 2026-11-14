import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import type { MeetingControls } from "../shared/api.ts";
import {
  applyMeetingsChange,
  type Meeting,
  type MeetingId,
  type MeetingSource,
  type MeetingsChange,
  type MeetingsState,
  type MeetingTranscriptChange,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import { mergeTranscript } from "./meetingsView.ts";
import { hubApi } from "./voice.ts";

export type Read<T> =
  | { kind: "reading" }
  | { kind: "failed"; retry: () => void }
  | { kind: "read"; value: T };

type HeldMeetings = MeetingsState | "reading" | "failed";

// As in useHistory: changes and the answer arrive in order, so the answer never replaces a list a
// change built.
function askForMeetings(setState: Dispatch<SetStateAction<HeldMeetings>>) {
  void hubApi()
    .getMeetings()
    .then(
      (first) => setState((current) => (typeof current === "string" ? first : current)),
      () => setState((current) => (current === "reading" ? "failed" : current)),
    );
}

// Main sends the folders and settings whole with every change. Keeping the held ones while they
// read the same lets the memoized rows skip a change to one meeting.
const unlessEqual = <T>(held: T, next: T) =>
  JSON.stringify(held) === JSON.stringify(next) ? held : next;

function applyChange(current: HeldMeetings, change: MeetingsChange): HeldMeetings {
  const held = typeof current === "string" ? null : current;
  const next = applyMeetingsChange(held, change);
  if (next === null) return current;
  if (held === null) return next;
  return {
    meetings: next.meetings,
    folders: unlessEqual(held.folders, next.folders),
    settings: unlessEqual(held.settings, next.settings),
  };
}

export function useMeetingsRead(): Read<MeetingsState> {
  const [state, setState] = useState<HeldMeetings>("reading");
  useEffect(() => {
    const unsubscribe = hubApi().onMeetings((change) =>
      setState((current) => applyChange(current, change)),
    );
    askForMeetings(setState);
    return unsubscribe;
  }, []);
  if (state === "reading") return { kind: "reading" };
  if (state === "failed") {
    return {
      kind: "failed",
      retry: () => {
        setState("reading");
        askForMeetings(setState);
      },
    };
  }
  return { kind: "read", value: state };
}

export function useMeetings(): MeetingsState | null {
  const meetings = useMeetingsRead();
  return meetings.kind === "read" ? meetings.value : null;
}

/**
 * The meeting's transcript, grown by the lines main pushes while it records. Pushed lines carry
 * the transcript revision they bring the file to; a meeting whose revision is ahead of the lines
 * held was rewritten, so the file is read again, and never for edits like notes or names. A line
 * pushed while a read is out is kept and merged in, since main may have read the file before
 * writing it. Until a read lands the last one stays; null once the meeting is gone.
 */
export function useMeetingTranscript(
  api: Pick<MeetingControls, "getMeeting" | "onMeetingTranscript">,
  meeting: Meeting,
): Read<readonly TranscriptEntry[] | null> {
  const [lines, setLines] = useState<{
    id: MeetingId;
    read: readonly TranscriptEntry[] | null;
    live: readonly TranscriptEntry[];
    revision: number;
  } | null>(null);
  const { id, transcriptRevision: revision } = meeting;
  const [readFor, setReadFor] = useState({ id, revision });
  const [failedRead, setFailedRead] = useState<typeof readFor | null>(null);
  if (lines?.id === id && revision > lines.revision && readFor.revision < revision) {
    setReadFor({ id, revision });
  }
  useEffect(() => {
    let current = true;
    // Lines pushed after this read was asked for; the lines pushed before it belong to the last one.
    let pending: MeetingTranscriptChange[] | null = [];
    const unsubscribe = api.onMeetingTranscript((change) => {
      if (change.id !== id) return;
      if (pending) pending.push(change);
      else {
        setLines(
          (was) =>
            was && {
              ...was,
              live: [...was.live, ...change.entries],
              revision: Math.max(was.revision, change.revision),
            },
        );
      }
    });
    void api.getMeeting(id).then(
      (detail) => {
        if (!current || !pending) return;
        const pushed = pending;
        pending = null;
        setLines({
          id,
          read: detail?.transcript ?? null,
          live: pushed.flatMap((change) => change.entries),
          revision: Math.max(
            detail?.meeting.transcriptRevision ?? 0,
            ...pushed.map((change) => change.revision),
          ),
        });
      },
      () => {
        if (current) setFailedRead(readFor);
      },
    );
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api, id, readFor]);
  const failed = failedRead === readFor;
  return useMemo((): Read<readonly TranscriptEntry[] | null> => {
    if (failed) return { kind: "failed", retry: () => setReadFor((was) => ({ ...was })) };
    if (lines?.id !== id) return { kind: "reading" };
    return { kind: "read", value: lines.read && mergeTranscript(lines.read, lines.live) };
  }, [failed, id, lines]);
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
