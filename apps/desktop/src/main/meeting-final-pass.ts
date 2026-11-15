import { randomUUID } from "node:crypto";

import {
  addSpeakers,
  type Meeting,
  type Segment,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import type { HelperEvent } from "./protocol.ts";

export type FinalSegment = Extract<HelperEvent, { type: "meeting.finalized" }>["segments"][number];

export function applyFinalPass(
  meeting: Meeting,
  transcript: readonly TranscriptEntry[],
  segments: readonly FinalSegment[],
  fromMs: number,
  newId: () => string = randomUUID,
): { meeting: Meeting; transcript: TranscriptEntry[] } {
  const kept = transcript.filter((entry) => entry.kind === "marker" || entry.startMs < fromMs);
  const named = new Set(
    kept.flatMap((entry) =>
      entry.kind === "segment" && entry.source === "system" && entry.speakerId
        ? [entry.speakerId]
        : [],
    ),
  );
  const last = meeting.speakers.findLastIndex(({ id }) => named.has(id));
  const voices = Math.max(-1, ...segments.map(({ speaker }) => speaker ?? -1)) + 1;
  const { meeting: next, ids } = addSpeakers(
    { ...meeting, speakers: meeting.speakers.slice(0, last + 1) },
    voices,
  );
  const final = segments.map((segment): Segment => {
    const base = {
      kind: "segment",
      id: newId(),
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    } as const;
    return segment.source === "mic"
      ? { ...base, source: "mic" }
      : {
          ...base,
          source: "system",
          speakerId: segment.speaker === null ? null : ids[segment.speaker]!,
        };
  });
  return { meeting: next, transcript: [...kept, ...final] };
}
