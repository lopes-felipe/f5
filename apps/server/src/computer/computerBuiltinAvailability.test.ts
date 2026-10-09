import { describe, expect, it, vi } from "vitest";
import { probeComputerBuiltin } from "./computerBuiltinAvailability";
describe("installed provider computer-use compatibility", () => {
  it("does not inspect plugins for unsupported SDK/platform combinations", async () => {
    const read = vi.fn();
    expect(
      (await probeComputerBuiltin({ provider: "claude", platform: "darwin", read })).reason,
    ).toContain("interactive");
    expect(
      (await probeComputerBuiltin({ provider: "codex", platform: "win32", read })).reason,
    ).toContain("unsupported");
    expect(read).not.toHaveBeenCalled();
  });
  it("reports the observed plugin version/hash without treating presence as a gate pass", async () => {
    const read = async (path: string) =>
      path.endsWith("plugin.json")
        ? JSON.stringify({ name: "unified-computer-use", version: "26.930.51102" })
        : JSON.stringify({
            mcpServers: { cua_repl: { enabled: false, command: "node", args: [] } },
          });
    const result = await probeComputerBuiltin({
      provider: "codex",
      platform: "darwin",
      chatGptResources: "/fixture",
      read,
    });
    expect(result.available).toBe(false);
    expect(result.version).toBe("26.930.51102");
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.reason).toContain("runtime configuration");
  });
  it("fails closed for missing or malformed plugin configuration", async () => {
    for (const read of [
      async () => {
        throw Object.assign(new Error(), { code: "ENOENT" });
      },
      async () => "not JSON",
      async () => "{}",
    ])
      expect(
        (await probeComputerBuiltin({ provider: "codex", platform: "darwin", read })).available,
      ).toBe(false);
  });
});
