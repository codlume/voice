import { test, expect, type Page } from "@playwright/test";
import type { Command } from "../../packages/contracts/src/desktop";
import type { SessionSnapshot } from "../../packages/contracts/src/session";

// A simulated preload whose session changes only through the commands the renderer sends.
async function simulate(page: Page, initial: Partial<SessionSnapshot>) {
  await page.addInitScript((overrides) => {
    const sent: Command[] = [];
    let session: SessionSnapshot = {
      phase: "idle",
      origin: null,
      armedPaste: null,
      blocker: null,
      notice: null,
      message: "Ready.",
      practiceText: "",
      recovery: [],
      recoveryMessage: "",
      quitWarning: false,
      pendingPractice: null,
      latestSuccessful: null,
      lastTranscript: null,
      lastUpdate: "session",
      ...overrides,
    };
    const listeners = new Set<() => void>();
    const reply = () => ({
      ok: true as const,
      settings: { appearance: "light" as const },
      status: {
        storage: "ready" as const,
        helper: "ready" as const,
        capture: session.phase === "recording" ? ("active" as const) : ("available" as const),
        shortcuts: "listening" as const,
      },
      session,
    });
    Object.assign(window, {
      sent,
      setSession(change: Partial<SessionSnapshot>) {
        session = { ...session, ...change };
        for (const listener of listeners) listener();
      },
    });
    window.voice = {
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onReveal: () => () => {},
      command: async (command) => {
        sent.push(command);
        if (command.type === "session.start")
          session = {
            ...session,
            phase: "recording",
            origin: command.origin,
            blocker: "busy",
            message: "Recording. Use the toggle shortcut or Stop to finish.",
          };
        if (command.type === "session.stop")
          session = { ...session, phase: "processing", message: "Finishing transcription…" };
        return reply();
      },
    };
  }, initial);
}
// Commands other than the state reads each change notification triggers.
const sent = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { sent: Command[] }).sent
      .map(({ type }) => type)
      .filter((type) => type !== "status.get"),
  );
const setSession = (page: Page, change: Partial<SessionSnapshot>) =>
  page.evaluate(
    (value) => (window as unknown as { setSession: (change: unknown) => void }).setSession(value),
    change,
  );

test("floating bar renders shared dark tokens and sends the same session commands", async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 84 });
  await simulate(page, {});
  await page.goto("/?view=status");
  const bar = page.getByRole("status", { name: "Dictation status" });
  await expect(bar).toHaveCSS("background-color", "rgb(32, 46, 64)");
  await expect(bar).toHaveCSS("color", "rgb(233, 239, 247)");
  await expect(page.getByTestId("panel-status")).toHaveText("Ready.");
  await expect(bar.getByRole("button")).toHaveCount(1);
  await bar.getByRole("button", { name: "Start dictation" }).click();
  await expect(page.getByTestId("panel-status")).toHaveText(
    "Recording. Use the toggle shortcut or Stop to finish.",
  );
  await expect(bar.locator("span").first()).toHaveCSS("background-color", "rgb(255, 95, 87)");
  await expect(bar.getByRole("button", { name: "Start dictation" })).toHaveCount(0);
  await bar.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("panel-status")).toHaveText("Finishing transcription…");
  await expect(bar.locator("span").first()).toHaveCSS("background-color", "rgb(176, 191, 210)");
  await expect(bar.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await bar.getByRole("button", { name: "Cancel", exact: true }).click();
  await setSession(page, {
    phase: "failed",
    blocker: null,
    notice: "uncertain",
    message: "Check your target. The transcript is in recovery.",
  });
  await expect(page.getByTestId("panel-status")).toHaveText(
    "Check your target. The transcript is in recovery.",
  );
  await bar.getByRole("button", { name: "Open recovery" }).click();
  await setSession(page, { notice: "setup", message: "Deepgram rejected the key." });
  await bar.getByRole("button", { name: "Open Settings" }).click();
  await setSession(page, { notice: "no-speech", message: "No speech detected" });
  await expect(bar.getByRole("button", { name: /Open/ })).toHaveCount(0);
  await setSession(page, { lastUpdate: "recovery", recoveryMessage: "Copied." });
  await expect(page.getByTestId("panel-status")).toHaveText("Copied.");
  await setSession(page, { lastUpdate: "session" });
  await setSession(page, { phase: "idle", blocker: "recovery-full", notice: null });
  await expect(page.getByTestId("panel-status")).toHaveText(
    "Recovery is full. Resolve or discard a session first.",
  );
  await expect(bar.getByRole("button", { name: "Start dictation" })).toBeDisabled();
  await page.screenshot({ path: "test-results/bar-recovery-full.png" });
  expect(await sent(page)).toEqual([
    "session.start",
    "session.stop",
    "session.cancel",
    "app.open",
    "app.open",
  ]);
  const opened = await page.evaluate(() =>
    (window as unknown as { sent: Command[] }).sent.flatMap((command) =>
      command.type === "app.open" ? [command.view] : [],
    ),
  );
  expect(opened).toEqual(["recovery", "setup"]);
});

test("compact bar shows only Start and the main window disables Start with the cause", async ({
  page,
}) => {
  await page.setViewportSize({ width: 112, height: 40 });
  await simulate(page, {});
  await page.goto("/?view=status");
  const bar = page.getByRole("status", { name: "Dictation status" });
  await expect(page.getByTestId("panel-status")).toBeHidden();
  await expect(bar.getByRole("button", { name: "Start dictation" })).toBeVisible();
  await page.screenshot({ path: "test-results/bar-compact.png" });

  await page.setViewportSize({ width: 820, height: 820 });
  await simulate(page, { blocker: "setup" });
  await page.goto("/");
  const dictation = page.getByRole("region", { name: "System-wide dictation" });
  await expect(dictation.getByRole("button", { name: "Start dictation" })).toBeDisabled();
  await expect(dictation.getByTestId("start-blocker")).toHaveText(
    "Start unavailable: Complete or repair dictation setup first.",
  );
  await expect(page.getByRole("button", { name: "Start practice" })).toBeDisabled();
  await dictation.getByRole("button", { name: "Open Settings" }).click();
  await setSession(page, { blocker: null });
  await dictation.getByRole("button", { name: "Start dictation" }).click();
  await expect(dictation.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await dictation.getByRole("button", { name: "Cancel", exact: true }).click();
  await dictation.screenshot({ path: "test-results/main-dictation-controls.png" });
  const commands = await page.evaluate(() =>
    (window as unknown as { sent: Command[] }).sent.filter(
      (command) => command.type !== "settings.get" && command.type !== "status.get",
    ),
  );
  expect(commands).toEqual([
    { type: "app.open", view: "setup" },
    { type: "session.start", origin: "dictation" },
    { type: "session.cancel" },
  ]);
});
