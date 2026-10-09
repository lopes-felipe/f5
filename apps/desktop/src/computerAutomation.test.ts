import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_AUTOMATION_STATUS_CHANNEL,
  computerAutomationStatus,
  registerComputerAutomationIpc,
} from "./computerAutomation";

describe("F5-native computer control gate", () => {
  it("stays unavailable with an explicit reason until certified", () => {
    for (const platform of ["darwin", "win32"] as const) {
      expect(computerAutomationStatus(platform)).toMatchObject({
        available: false,
        reason: "not-certified",
      });
    }
    expect(computerAutomationStatus("linux")).toMatchObject({
      available: false,
      reason: "unsupported-platform",
    });
  });

  it("exposes only the status channel", () => {
    const handlers = new Map<string, () => unknown>();
    registerComputerAutomationIpc({
      removeHandler: vi.fn(),
      handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler),
    } as never);
    expect([...handlers.keys()]).toEqual([COMPUTER_AUTOMATION_STATUS_CHANNEL]);
    expect(handlers.get(COMPUTER_AUTOMATION_STATUS_CHANNEL)?.()).toMatchObject({
      available: false,
    });
  });
});
