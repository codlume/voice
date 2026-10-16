import type { CleanupStyle } from "./style.ts";

export const STYLINGS = ["casual", "semi-casual", "semi-formal", "formal"] as const;

export const CONTEXTS = ["general", "email"] as const;

export type S1Control = {
  styling: (typeof STYLINGS)[number];
  context: (typeof CONTEXTS)[number];
};

// Calibration: shorter replies under the email context gained a greeting line or lost words.
export const EMAIL_LAYOUT_MIN_WORDS = 10;

// Every product style runs semi-formal and differs only by its finish: S1's casual strips
// apostrophes ("we're" becomes "were") and semi-casual keeps fillers.
export function s1Control(style: CleanupStyle, raw: string, chunks: number): S1Control {
  const email =
    style.layout === "email" &&
    chunks === 1 &&
    raw.split(/\s+/u).filter(Boolean).length >= EMAIL_LAYOUT_MIN_WORDS;
  return { styling: "semi-formal", context: email ? "email" : "general" };
}

const SYSTEM_PROMPT =
  "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.";

// S1-mini is trained on this exact Qwen3 chat template, including the empty think block that opens the assistant turn.
// The model requires all three control fields.
export function buildS1MiniPrompt(raw: string, control: S1Control): string {
  return (
    `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n[Styling: ${control.styling}] [Structure: prose] [Context: ${control.context}]\n${raw}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  );
}
