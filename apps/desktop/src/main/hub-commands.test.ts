import { describe, expect, test, vi } from "vite-plus/test";

import { Channel, type HubApi } from "../shared/api.ts";
import { registerHubCommands, type HubCommandDeps } from "./hub-commands.ts";
import type { Commands } from "./ipc.ts";

vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, clipboard: {}, dialog: {}, shell: {} }));

function meetingCommandsWith(assertNotRestarting: () => void) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const start = vi.fn(async () => ({ kind: "refused", message: "not under test" }));
  const toggle = vi.fn(async () => ({ kind: "refused", message: "not under test" }));
  const commands = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  } as unknown as Commands<HubApi>;
  const deps = {
    assertNotRestarting,
    meetingRecorder: { start, toggle },
    log: () => {},
  } as unknown as HubCommandDeps;
  registerHubCommands(commands, deps);
  return {
    start,
    toggle,
    press: () => handlers.get(Channel.startMeeting)?.({}),
    pressShortcut: () => handlers.get(Channel.toggleMeeting)?.({}),
  };
}

describe("hub commands", () => {
  test("a meeting cannot start while a restart is under way", () => {
    const { start, press } = meetingCommandsWith(() => {
      throw new Error("Voice is restarting.");
    });
    expect(press).toThrow("Voice is restarting.");
    expect(start).not.toHaveBeenCalled();
  });

  test("the meeting shortcut in the Voice window does nothing while a restart is under way", () => {
    const { toggle, pressShortcut } = meetingCommandsWith(() => {
      throw new Error("Voice is restarting.");
    });
    expect(pressShortcut).toThrow("Voice is restarting.");
    expect(toggle).not.toHaveBeenCalled();
  });

  test("the meeting shortcut in the Voice window toggles the meeting otherwise", () => {
    const { toggle, pressShortcut } = meetingCommandsWith(() => {});
    void pressShortcut();
    expect(toggle).toHaveBeenCalledOnce();
  });

  test("a meeting starts when no restart is under way", () => {
    const { start, press } = meetingCommandsWith(() => {});
    void press();
    expect(start).toHaveBeenCalledOnce();
  });
});
