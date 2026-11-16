import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { CodexAppServerManager } from "./codexAppServerManager.ts";
const threadId = ThreadId.makeUnsafe("app-native-thread");
function fixture() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready" as "ready" | "running" | "closed",
      threadId,
      resumeCursor: { threadId: "native-app-thread" },
    },
    stopping: false,
    mcpObservationContext: {},
  };
  const sessions = (manager as unknown as { sessions: Map<ThreadId, unknown> }).sessions;
  sessions.set(threadId, context);
  const state = {
    readonly: false,
    hidden: false,
    calls: 0,
    onList: undefined as (() => void) | undefined,
    onCall: undefined as (() => void) | undefined,
  };
  const request = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockImplementation(async (_context, method) => {
      if (method === "mcpServerStatus/list") {
        state.onList?.();
        return {
          data: [
            {
              name: "weather",
              tools: {
                forecast: {
                  name: "forecast",
                  annotations: { readOnlyHint: state.readonly },
                  _meta: { ui: { visibility: state.hidden ? ["model"] : ["app"] } },
                },
              },
            },
          ],
          nextCursor: null,
        };
      }
      if (method === "mcpServer/tool/call") {
        state.calls++;
        state.onCall?.();
        return { content: [{ type: "text", text: "Sunny" }] };
      }
      if (method === "mcpServer/resource/read")
        return { contents: [{ uri: "ui://weather/app", text: "Weather" }] };
      return {};
    });
  return { manager, context, sessions, state, request };
}
describe("native Codex MCP app controls", () => {
  it("uses the existing idle session and native thread identity, with no session recovery", async () => {
    const f = fixture();
    const identity = f.manager.getMcpAppSessionIdentity(threadId);
    await f.manager.callMcpAppTool(
      threadId,
      "weather",
      "forecast",
      { city: "Berlin" },
      identity,
      true,
    );
    expect(f.state.calls).toBe(1);
    expect(f.request).toHaveBeenCalledWith(
      f.context,
      "mcpServer/tool/call",
      {
        threadId: "native-app-thread",
        server: "weather",
        tool: "forecast",
        arguments: { city: "Berlin" },
      },
      30000,
    );
    await f.manager.readMcpAppResource(threadId, "weather", "ui://weather/app", identity);
    expect(f.request).toHaveBeenCalledWith(
      f.context,
      "mcpServer/resource/read",
      { threadId: "native-app-thread", server: "weather", uri: "ui://weather/app" },
      10000,
    );
  });
  it("rechecks app visibility and read-only metadata immediately before native dispatch", async () => {
    const f = fixture(),
      identity = f.manager.getMcpAppSessionIdentity(threadId);
    await expect(
      f.manager.callMcpAppTool(threadId, "weather", "forecast", {}, identity, false),
    ).rejects.toThrow(/approval/);
    expect(f.state.calls).toBe(0);
    f.state.readonly = true;
    await f.manager.callMcpAppTool(threadId, "weather", "forecast", {}, identity, false);
    f.state.hidden = true;
    await expect(
      f.manager.callMcpAppTool(threadId, "weather", "forecast", {}, identity, true),
    ).rejects.toThrow(/unavailable/);
    expect(f.state.calls).toBe(1);
  });
  it("invalidates old approvals on MCP reload and refuses a session replaced during inventory", async () => {
    const f = fixture(),
      identity = f.manager.getMcpAppSessionIdentity(threadId);
    await f.manager.reloadMcpConfig(threadId);
    expect(f.manager.getMcpAppSessionIdentity(threadId)).not.toBe(identity);
    await expect(
      f.manager.callMcpAppTool(threadId, "weather", "forecast", {}, identity, true),
    ).rejects.toThrow(/changed/);
    const current = f.manager.getMcpAppSessionIdentity(threadId);
    f.state.onList = () => f.sessions.set(threadId, { ...f.context });
    await expect(
      f.manager.callMcpAppTool(threadId, "weather", "forecast", {}, current, true),
    ).rejects.toThrow(/superseded|changed/);
    expect(f.state.calls).toBe(0);
  });
  it("reports an unknown outcome after replacement during a mutation and never replays it", async () => {
    const f = fixture(),
      identity = f.manager.getMcpAppSessionIdentity(threadId);
    f.state.onCall = () => f.sessions.set(threadId, { ...f.context });
    await expect(
      f.manager.callMcpAppTool(threadId, "weather", "forecast", {}, identity, true),
    ).rejects.toThrow(/outcome is unknown/);
    expect(f.state.calls).toBe(1);
  });
  it("refuses closed or missing sessions and oversized arguments before transport", async () => {
    const f = fixture(),
      identity = f.manager.getMcpAppSessionIdentity(threadId);
    await expect(
      f.manager.callMcpAppTool(
        threadId,
        "weather",
        "forecast",
        { text: "x".repeat(65537) },
        identity,
        true,
      ),
    ).rejects.toThrow(/Invalid/);
    expect(f.request).not.toHaveBeenCalled();
    f.context.session.status = "closed";
    expect(() => f.manager.getMcpAppSessionIdentity(threadId)).toThrow(/closed/);
    f.sessions.delete(threadId);
    await expect(
      f.manager.readMcpAppResource(threadId, "weather", "ui://weather/app"),
    ).rejects.toThrow(/Unknown session/);
    expect(f.request).not.toHaveBeenCalled();
  });
});
