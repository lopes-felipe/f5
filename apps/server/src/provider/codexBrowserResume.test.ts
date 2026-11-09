import { describe, expect, it, vi } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import {
  buildCodexThreadOpenRequestParams,
  buildCodexThreadForkParams,
  CodexAppServerManager,
} from "../codexAppServerManager";
import { CODEX_BROWSER_RESUME_TOOL } from "./codexBrowserResume";

function harness() {
  const manager = new CodexAppServerManager();
  const resume = vi.fn(async (): Promise<unknown> => ({ state: "ready" }));
  const context = {
    browserResume: resume,
    browserResumeRegistered: true,
    mcpCalls: new Set<string>(),
    session: {
      threadId: "f5-thread",
      runtimeMode: "full-access",
      status: "running",
      activeTurnId: "turn",
      resumeCursor: { threadId: "provider-thread" },
    },
  };
  const internal = manager as unknown as {
    sessions: Map<string, unknown>;
    handleServerRequest(context: unknown, request: unknown): void;
    handleServerNotification(context: unknown, notification: unknown): void;
    writeServerRequestResponse(context: unknown, response: unknown): void;
  };
  internal.sessions.set("f5-thread", context);
  const reply = vi.spyOn(internal, "writeServerRequestResponse").mockImplementation(() => {});
  const call = (patch: Record<string, unknown> = {}) =>
    internal.handleServerRequest(context, {
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "provider-thread",
        turnId: "turn",
        callId: "call",
        namespace: null,
        tool: "browser_resume",
        arguments: { reason: "Continue browser work" },
        ...patch,
      },
    });
  return { manager, internal, resume, context, reply, call };
}

describe("browser_resume host tool", () => {
  it("registers the tool only on new provider threads, without unsupported resume fields", () => {
    const params = buildCodexThreadOpenRequestParams({
      runtimeMode: "full-access",
      browserResume: true,
      resumeThreadId: "old",
      cliVersion: "0.166.0",
    });
    expect(params.start.dynamicTools).toEqual([CODEX_BROWSER_RESUME_TOOL]);
    expect(params.resume).not.toHaveProperty("dynamicTools");
    expect(
      buildCodexThreadForkParams(
        {
          runtimeMode: "full-access",
          browserResume: true,
          cliVersion: "0.166.0",
        },
        "parent",
      ),
    ).not.toHaveProperty("dynamicTools");
    expect(
      buildCodexThreadOpenRequestParams({ runtimeMode: "full-access" }).start,
    ).not.toHaveProperty("dynamicTools");
  });

  it("returns the dynamic response directly through the host, outside MCP", async () => {
    const h = harness();
    h.call();
    await vi.waitFor(() =>
      expect(h.reply).toHaveBeenCalledWith(h.context, {
        id: 1,
        result: { success: true, contentItems: [{ type: "inputText", text: '{"state":"ready"}' }] },
      }),
    );
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it.each([
    { arguments: {} },
    { arguments: { reason: " " } },
    { arguments: { reason: "yes", unexpected: true } },
    { namespace: "foreign" },
    { threadId: "child-thread" },
    { turnId: "old-turn" },
  ])("refuses invalid, child-thread and stale requests: %j", async (patch) => {
    const h = harness();
    h.call(patch);
    await vi.waitFor(() =>
      expect(h.reply).toHaveBeenCalledWith(
        h.context,
        expect.objectContaining({ result: expect.objectContaining({ success: false }) }),
      ),
    );
    expect(h.resume).not.toHaveBeenCalled();
  });

  it("reports failures without a successful tool result", async () => {
    const h = harness();
    h.resume.mockRejectedValueOnce(new Error("Chrome requires recovery"));
    h.call();
    await vi.waitFor(() =>
      expect(h.reply).toHaveBeenCalledWith(
        h.context,
        expect.objectContaining({
          result: expect.objectContaining({
            success: false,
            contentItems: [{ type: "inputText", text: '{"error":"Chrome requires recovery"}' }],
          }),
        }),
      ),
    );
  });

  it("does not report success after the turn ends while resuming", async () => {
    const h = harness();
    let done!: () => void;
    h.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    h.call();
    h.context.session.activeTurnId = "new-turn";
    done();
    await vi.waitFor(() =>
      expect(h.reply).toHaveBeenCalledWith(
        h.context,
        expect.objectContaining({ result: expect.objectContaining({ success: false }) }),
      ),
    );
  });

  it("waits for unrelated MCP calls and rechecks lifecycle before allowing reload", async () => {
    const h = harness();
    h.context.mcpCalls.add("unrelated");
    let reloading = false;
    const check = vi.fn(async () => {});
    const waiting = h.manager
      .waitForMcpIdle(ThreadId.makeUnsafe("f5-thread"), performance.now() + 1000, check)
      .then(() => {
        reloading = true;
      });
    await Promise.resolve();
    expect(reloading).toBe(false);
    h.context.mcpCalls.clear();
    await waiting;
    expect(reloading).toBe(true);
    expect(check).toHaveBeenCalled();
  });
});
