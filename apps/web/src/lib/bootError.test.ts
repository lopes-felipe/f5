import { describe, expect, it } from "vitest";
import type { DesktopBridge } from "@t3tools/contracts";
import { buildBootErrorReport, resolveDebugCommand } from "./bootError";

describe("startup recovery", () => {
  it("quotes installed launchers and survives failed IPC", async () => {
    const bridge = (onPath: boolean) =>
      ({
        cliCommand: {
          state: async () => ({ installedPaths: { f5: "/Users/O'Neil/bin/f5" }, onPath }),
        },
      }) as unknown as DesktopBridge;
    expect(await resolveDebugCommand(bridge(false))).toBe("'/Users/O'\"'\"'Neil/bin/f5'");
    expect(await resolveDebugCommand(bridge(true))).toBe("f5");
    expect(await resolveDebugCommand(undefined)).toBe("f5");
    expect(
      await resolveDebugCommand({
        cliCommand: {
          state: async () => {
            throw new Error("IPC closed");
          },
        },
      } as unknown as DesktopBridge),
    ).toBe("f5");
  });
  it("bounds cyclic causes and redacts URL credentials", () => {
    const error = new Error("Failed https://user:secret@private.local/path?token=secret");
    error.cause = error;
    const report = buildBootErrorReport(error);
    expect(report).not.toContain("secret");
    expect(report).not.toContain("private.local");
    expect(report.length).toBeLessThan(7000);
  });
});
