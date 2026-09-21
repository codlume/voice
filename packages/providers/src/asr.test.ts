import { describe, expect, it } from "vite-plus/test";
import { Transcript } from "./asr";
import { result } from "./fixture";
describe("stable transcript assembly", () => {
  it("orders and deduplicates stable segments and waits for the final tail", () => {
    const transcript = new Transcript();
    transcript.accept(result(1, 1, "unfinished", false));
    transcript.accept(result(1, 1, "Final tail."));
    transcript.accept(result(0, 1, "Hello, Priya."));
    transcript.accept(result(0, 1, "Hello, Priya."));
    transcript.accept({ type: "Metadata", duration: 2, channels: 1 });
    expect(transcript.finish(2)).toBe("Hello, Priya. Final tail.");
  });
});
it("rejects missing final tail, gaps, conflicting duplicates and a different model", () => {
  const tail = new Transcript();
  tail.accept(result(0, 1, "Do not ship."));
  tail.accept({ type: "Metadata", duration: 2, channels: 1 });
  expect(() => tail.finish(2)).toThrow();
  const gap = new Transcript();
  gap.accept(result(1, 1, "Missing beginning."));
  gap.accept({ type: "Metadata", duration: 2, channels: 1 });
  expect(() => gap.finish(2)).toThrow();
  const conflict = new Transcript();
  conflict.accept(result(0, 1, "No."));
  expect(() => conflict.accept(result(0, 1, "Yes."))).toThrow();
  expect(() =>
    new Transcript().accept({
      ...result(0, 1, "Hello"),
      metadata: { model_info: { version: "2025-04-17.21547" }, model_uuid: "other" },
    }),
  ).toThrow();
});
it("requires stable silence coverage instead of inventing text", () => {
  const silence = new Transcript();
  silence.accept(result(0, 1, ""));
  silence.accept({ type: "Metadata", duration: 1, channels: 1 });
  expect(silence.finish(1)).toBe("");
  expect(() => new Transcript().finish(1)).toThrow();
});
it("replays captured synthetic provider events exactly, retaining the known identifier recognition failure", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/identifier-events.json", import.meta.url), "utf8"),
  );
  const transcript = new Transcript();
  for (const event of fixture.events) transcript.accept(event);
  const text = transcript.finish(fixture.sourceAudioSeconds);
  expect(text).toBe(fixture.expectedProviderText);
  expect(text).toContain("fixed slash audio dash timeout");
  // Assembly passes; the source reference still fails. Never change it to bless the ASR error.
  expect(text).not.toContain("fix/audio-timeout");
});
it("preserves a partial for recovery without presenting it as a final transcript", () => {
  const transcript = new Transcript();
  transcript.accept(result(0, 1, "First sentence."));
  transcript.accept(result(1, 1, "Unfinished thought", false));
  expect(transcript.availableText()).toBe("First sentence. Unfinished thought");
  expect(transcript.text()).toBe("First sentence.");
  transcript.accept(result(1, 1, "Finished thought."));
  expect(transcript.availableText()).toBe("First sentence. Finished thought.");
});
it("does not hide a missing speech tail inside the duration tolerance", () => {
  const transcript = new Transcript();
  transcript.accept(result(0, 0.95, "Do"));
  transcript.accept(result(0.95, 0.05, "not", false));
  transcript.accept({ type: "Metadata", duration: 1, channels: 1 });
  expect(() => transcript.finish(1)).toThrow();
});
