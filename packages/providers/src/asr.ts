import { Schema } from "effect";
export const modelVersion = "2025-04-17.21547";
export const modelUuid = "40bd3654-e622-47c4-a111-63a61b23bfe8";
export const deepgramUrl =
  "wss://api.eu.deepgram.com/v1/listen?" +
  new URLSearchParams({
    model: "nova-3-general",
    language: "en",
    version: modelVersion,
    mip_opt_out: "true",
    interim_results: "true",
    channels: "1",
    encoding: "linear16",
    sample_rate: "16000",
    endpointing: "300",
    punctuate: "true",
    smart_format: "false",
    filler_words: "true",
    profanity_filter: "false",
    numerals: "false",
    dictation: "false",
  });
const time = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(301));
const decodeResult = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("Results"),
    start: time,
    duration: time,
    is_final: Schema.Boolean,
    channel_index: Schema.Tuple([Schema.Literal(0), Schema.Literal(1)]),
    metadata: Schema.Struct({
      model_uuid: Schema.Literal(modelUuid),
      model_info: Schema.Struct({ version: Schema.Literal(modelVersion) }),
    }),
    channel: Schema.Struct({
      alternatives: Schema.Array(
        Schema.Struct({ transcript: Schema.String.check(Schema.isMaxLength(100_000)) }),
      ),
    }),
  }),
);
const decodeMetadata = Schema.decodeUnknownSync(
  Schema.Struct({ type: Schema.Literal("Metadata"), duration: time, channels: Schema.Literal(1) }),
);

// A stream is complete only when stable ranges cover the submitted audio, including silence.
export class Transcript {
  private segments = new Map<number, { end: number; text: string }>();
  private duration: number | undefined;
  private partial: { start: number; text: string } | undefined;
  accept(value: unknown) {
    if (typeof value !== "object" || value === null || !("type" in value))
      throw new Error("invalid-provider-event");
    if (value.type === "Metadata") {
      if (this.duration !== undefined) throw new Error("duplicate-metadata");
      this.duration = decodeMetadata(value).duration;
    } else if (value.type === "Results") {
      const event = decodeResult(value);
      const text = event.channel.alternatives[0]?.transcript;
      if (text === undefined || this.duration !== undefined)
        throw new Error("invalid-provider-event");
      if (!event.is_final) {
        this.partial = { start: event.start, text };
        return;
      }
      const end = event.start + event.duration;
      const previous = this.segments.get(event.start);
      if (previous && (previous.end !== end || previous.text !== text))
        throw new Error("conflicting-segment");
      if (event.duration === 0) {
        if (text) throw new Error("empty-speech-range");
        return;
      }
      for (const [start, segment] of this.segments) {
        if (start !== event.start && start < end - 0.0001 && segment.end > event.start + 0.0001)
          throw new Error("overlapping-segment");
      }
      this.segments.set(event.start, { end, text });
      if (this.partial && this.partial.start < end) this.partial = undefined;
    } else throw new Error("unexpected-provider-event");
  }
  text() {
    return [...this.segments]
      .toSorted(([a], [b]) => a - b)
      .map(([, segment]) => segment.text)
      .filter(Boolean)
      .join(" ");
  }
  availableText() {
    const lastEnd = Math.max(0, ...[...this.segments.values()].map((segment) => segment.end));
    return [this.text(), this.partial && this.partial.start >= lastEnd ? this.partial.text : ""]
      .filter(Boolean)
      .join(" ");
  }
  finish(sentSeconds: number) {
    if (
      this.duration === undefined ||
      Math.abs(this.duration - sentSeconds) > 0.1 ||
      !this.segments.size
    )
      throw new Error("incomplete-audio");
    let covered = 0;
    for (const [start, segment] of [...this.segments].toSorted(([a], [b]) => a - b)) {
      if (Math.abs(start - covered) > 0.001 || segment.end > sentSeconds + 0.1)
        throw new Error("segment-gap");
      covered = segment.end;
    }
    if (Math.abs(covered - this.duration) > 0.001 || this.availableText() !== this.text())
      throw new Error("missing-final-tail");
    return this.text();
  }
}
