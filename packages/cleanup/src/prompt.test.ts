import { expect, test } from "vite-plus/test";

import { buildS1MiniPrompt, s1Control } from "./prompt.ts";
import { WRITING_STYLES, type CleanupStyle } from "./style.ts";

const nineWords = "hi maria thanks for the deck i will reply";
const tenWords = `${nineWords} tomorrow`;

const controlLine = (style: CleanupStyle, raw: string, chunks: number) =>
  /\[Styling: .*\]/.exec(buildS1MiniPrompt(raw, s1Control(style, raw, chunks)))![0];

test("builds the exact S1-mini Qwen3 template from the model card", () => {
  const prompt = buildS1MiniPrompt("things to buy milk eggs", {
    styling: "semi-formal",
    context: "general",
  });

  expect(prompt).toBe(
    "<|im_start|>system\n" +
      "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.<|im_end|>\n" +
      "<|im_start|>user\n" +
      "[Styling: semi-formal] [Structure: prose] [Context: general]\n" +
      "things to buy milk eggs<|im_end|>\n" +
      "<|im_start|>assistant\n" +
      "<think>\n" +
      "\n" +
      "</think>\n" +
      "\n",
  );
});

test.each(WRITING_STYLES)("%s asks S1-mini for semi-formal in both layouts", (style) => {
  expect(controlLine({ style, layout: "general" }, tenWords, 1)).toBe(
    "[Styling: semi-formal] [Structure: prose] [Context: general]",
  );
  expect(controlLine({ style, layout: "email" }, tenWords, 1)).toBe(
    "[Styling: semi-formal] [Structure: prose] [Context: email]",
  );
});

test.each([
  ["under the word minimum", nineWords, 1],
  ["split into two chunks", tenWords, 2],
])("email layout falls back to general for a transcript %s", (_name, raw, chunks) => {
  expect(controlLine({ style: "formal", layout: "email" }, raw, chunks)).toBe(
    "[Styling: semi-formal] [Structure: prose] [Context: general]",
  );
});
