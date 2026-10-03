import { describe, expect, test } from "vite-plus/test";

import { actionErrorMessage } from "./actionError.ts";

describe("actionErrorMessage", () => {
  test("shows the main-process message without the IPC wrapper", () => {
    const wrapped = new Error(
      "Error invoking remote method 'voice:submitSignInCode': Error: Paste the whole code shown in the browser.",
    );
    expect(actionErrorMessage(wrapped, "Could not sign in.")).toBe(
      "Paste the whole code shown in the browser.",
    );
    expect(actionErrorMessage(new Error("Voice is restarting."), "Could not sign in.")).toBe(
      "Voice is restarting.",
    );
    expect(actionErrorMessage("nope", "Could not sign in.")).toBe("Could not sign in.");
  });
});
