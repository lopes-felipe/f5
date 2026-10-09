import { describe, expect, it, vi } from "vitest";
import { probeCodexBundledRuntime } from "./codexBundledRuntime";
const plugin = JSON.stringify({ name: "chrome", version: "26.1002.52244" });
const missing = () => {
  throw Object.assign(new Error("not installed"), { code: "ENOENT" });
};
const probe = (read: (path: string) => Promise<string>) =>
  probeCodexBundledRuntime({
    capability: "chrome",
    platform: "darwin",
    chatGptResources: "/fixture",
    read,
  });
describe("Codex bundled Chrome launch readiness", () => {
  it("distinguishes a host-managed plugin from a missing installation", async () => {
    const result = await probe(async (path) => (path.endsWith("plugin.json") ? plugin : missing()));
    expect(result).toMatchObject({
      available: false,
      state: "host-managed",
      version: "26.1002.52244",
    });
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await probe(async () => missing())).toMatchObject({
      available: false,
      state: "not-installed",
    });
  });
  it("does not treat a declared missing MCP file or unreadable file as host-managed", async () => {
    expect(
      await probe(async (path) =>
        path.endsWith("plugin.json")
          ? JSON.stringify({ name: "chrome", version: "1", mcpServers: "./.mcp.json" })
          : missing(),
      ),
    ).toMatchObject({ state: "unreadable", available: false });
    expect(
      await probe(async (path) =>
        path.endsWith("plugin.json")
          ? plugin
          : Promise.reject(Object.assign(new Error(), { code: "EACCES" })),
      ),
    ).toMatchObject({ state: "unreadable", available: false });
  });
  it("requires certification even for concrete launch metadata and hashes changes", async () => {
    const run = (args: string[]) =>
      probe(async (path) =>
        path.endsWith("plugin.json")
          ? plugin
          : JSON.stringify({ mcpServers: { node_repl: { command: "node", args } } }),
      );
    const placeholder = await run([]);
    const configured = await run(["/fixture/server.mjs"]);
    expect(placeholder.state).toBe("host-managed");
    expect(configured).toMatchObject({ state: "uncertified", available: false });
    expect(configured.manifestHash).not.toBe(placeholder.manifestHash);
  });
  it("does no filesystem reads on unsupported platforms", async () => {
    const read = vi.fn();
    expect(
      await probeCodexBundledRuntime({ capability: "chrome", platform: "win32", read }),
    ).toMatchObject({ state: "unsupported-platform", available: false });
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects look-alike plugin identity and malformed launch metadata", async () => {
    for (const [manifest, mcp] of [
      [JSON.stringify({ name: "chrome-copy", version: "1" }), "{}"],
      [plugin, "{}"],
      [plugin, "not-json"],
    ])
      expect(
        await probe(async (path) => (path.endsWith("plugin.json") ? manifest! : mcp!)),
      ).toMatchObject({ state: "unreadable", available: false });
  });
});
