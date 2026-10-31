import { randomUUID } from "node:crypto";

import {
  addSpeakers,
  type Meeting,
  type Segment,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import type { HelperEvent } from "./protocol.ts";

export type FinalSegment = Extract<HelperEvent, { type: "meeting.finalized" }>["segments"][number];

/**
 * The transcript with the final pass in place of the live segments from `fromMs`, the start of
 * the audio files it read. Markers stay, and so do segments from before `fromMs`, whose audio
 * an earlier final pass already replaced and deleted. Each voice the diarizer found becomes a
 * new speaker; speakers only replaced segments named came from an interrupted earlier run over
 * the same audio and are dropped, so a rerun converges on the same result.
 */
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
  // Speakers number in order, so keeping up to the last one a kept segment names keeps ids unique.
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
      final: true,
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
