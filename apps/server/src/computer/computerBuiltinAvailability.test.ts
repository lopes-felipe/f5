import { describe, expect, it, vi } from "vitest";
import { probeComputerBuiltin } from "./computerBuiltinAvailability";
import type { CodexInspectionIo } from "./codexNativeIntegrations";

const io = (): CodexInspectionIo => ({
  readText: vi.fn(async () => {
    throw new Error("not read");
  }),
  isFile: vi.fn(async () => false),
  realpath: vi.fn(async (path: string) => path),
  fingerprint: vi.fn(async (path: string) => path),
  verify: vi.fn(async () => ({ ok: false as const, reason: "invalid" as const })),
  inspectRegistrations: vi.fn(async () => []),
});

describe("installed provider computer-use compatibility", () => {
  it("does not inspect anything for unsupported SDK/platform combinations", async () => {
    const fixture = io();
    expect(
      (await probeComputerBuiltin({ provider: "claude", platform: "darwin", io: fixture })).reason,
    ).toContain("interactive terminal sessions");
    expect(
      (await probeComputerBuiltin({ provider: "codex", platform: "win32", io: fixture })).reason,
    ).toContain("unsupported");
    expect(fixture.readText).not.toHaveBeenCalled();
  });

  it("reads nothing while no Codex Computer Use record exists", async () => {
    const fixture = io();
    const result = await probeComputerBuiltin({
      provider: "codex",
      platform: "darwin",
      arch: "arm64",
      userHome: "/Users/me",
      io: fixture,
    });
    expect(result).toEqual({
      available: false,
      reason: "Codex Computer Use is awaiting a live safety certification for this F5 build.",
    });
    expect(fixture.readText).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
  });
});
