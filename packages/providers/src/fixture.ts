const metadata = {
  model_uuid: "40bd3654-e622-47c4-a111-63a61b23bfe8",
  model_info: { version: "2025-04-17.21547" },
};
export const result = (start: number, duration: number, transcript: string, is_final = true) => ({
  type: "Results",
  channel_index: [0, 1],
  start,
  duration,
  is_final,
  speech_final: true,
  metadata,
  channel: { alternatives: [{ transcript }] },
});
