import { expect, test } from "vite-plus/test";

import { buildS1MiniPrompt } from "./prompt.ts";

test("builds the exact S1-mini Qwen3 template from the model card", () => {
  const prompt = buildS1MiniPrompt("things to buy milk eggs", { styling: "casual" });

  expect(prompt).toBe(
    "<|im_start|>system\n" +
      "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.<|im_end|>\n" +
      "<|im_start|>user\n" +
      "[Styling: casual] [Structure: prose] [Context: general]\n" +
      "things to buy milk eggs<|im_end|>\n" +
      "<|im_start|>assistant\n" +
      "<think>\n" +
      "\n" +
      "</think>\n" +
      "\n",
  );
});
