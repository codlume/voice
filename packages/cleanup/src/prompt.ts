export const STYLINGS = ["casual", "semi-casual", "semi-formal", "formal"] as const;

export const CONTEXTS = ["general", "email"] as const;

export type CleanupStyle = {
  styling: (typeof STYLINGS)[number];
  context?: (typeof CONTEXTS)[number];
};

const SYSTEM_PROMPT =
  "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";

// S1-mini is trained on this exact Qwen3 chat template, including the empty think block that opens the assistant turn.
// The model requires all three control fields.
export function buildS1MiniPrompt(raw: string, style: CleanupStyle): string {
  return (
    `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n[Styling: ${style.styling}] [Structure: prose] [Context: ${style.context ?? "general"}]\n${raw}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  );
}
