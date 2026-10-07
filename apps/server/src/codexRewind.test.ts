import { describe, expect, it, vi } from "vitest";
import { ThreadId, type ProviderEvent, type ProviderSession } from "@t3tools/contracts";
import {
  CodexAppServerManager,
  CodexJsonRpcError,
  selectCodexRewindStrategy,
  isCodexLegacyHistoryRevertError,
} from "./codexAppServerManager.ts";

const id = ThreadId.makeUnsafe("f5-thread");
const page = (...ids: string[]) => ({
  data: ids.map((id) => ({ id, items: [], itemsView: "full" })),
  nextCursor: null,
});
const unknown = (method: string) => new CodexJsonRpcError(method, -32601, "method not found");
const legacy = () =>
  new CodexJsonRpcError("thread/revert", -32600, "thread/revert only supports paginated threads");

function harness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      threadId: id,
      status: "ready",
      runtimeMode: "full-access",
      cwd: "/tmp/project",
      model: "gpt-5.3-codex",
      resumeCursor: { threadId: "old", retainedMetadata: "keep" },
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z",
    } as ProviderSession,
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    nativeRequestCorrelations: new Map(),
    legacyHistoryThreadIds: new Set<string>(),
    revertUnsupported: false,
    rollbackUnsupported: false,
    unsettledFork: false,
  };
  const internals = manager as unknown as {
    requireSession: () => typeof context;
    sendRequest: (...args: unknown[]) => Promise<unknown>;
    handleServerNotification: (context: unknown, notification: unknown) => void;
  };
  vi.spyOn(internals, "requireSession").mockReturnValue(context);
  const send = vi.spyOn(internals, "sendRequest");
  const events: ProviderEvent[] = [];
  manager.on("event", (event) => events.push(event));
  const notify = (method: string, params: unknown) =>
    internals.handleServerNotification(context, { method, params });
  return { manager, context, send, notify, events };
}

describe("Codex rewind fork fallback", () => {
  it("selects strategy per thread and matches only the pinned legacy rejection", () => {
    const flags = { legacyHistoryThreadIds: new Set(["legacy"]) };
    expect(selectCodexRewindStrategy(flags, "legacy")).toBe("rollback");
    expect(selectCodexRewindStrategy(flags, "new")).toBe("revert");
    expect(selectCodexRewindStrategy({ ...flags, rollbackUnsupported: true }, "legacy")).toBe(
      "fork",
    );
    expect(isCodexLegacyHistoryRevertError(legacy())).toBe(true);
    expect(
      isCodexLegacyHistoryRevertError(new Error("thread/revert only supports paginated threads")),
    ).toBe(false);
  });

  it("validates a legacy fork, persists adoption, routes early events and tries revert on the new id", async () => {
    const { manager, context, send, notify, events } = harness();
    send
      .mockRejectedValueOnce(legacy())
      .mockResolvedValueOnce(page("keep", "drop"))
      .mockRejectedValueOnce(unknown("thread/rollback"))
      .mockImplementationOnce(async () => {
        notify("thread/started", { thread: { id: "forked" } });
        notify("item/agentMessage/delta", {
          threadId: "forked",
          turnId: "keep",
          itemId: "item",
          delta: "early",
        });
        expect(context.session.resumeCursor).toEqual({ threadId: "old", retainedMetadata: "keep" });
        return { thread: { id: "forked", turns: [] } };
      })
      .mockResolvedValueOnce(page("keep"))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(page("keep"));
    const persist = vi.fn(async (session: ProviderSession) => {
      expect(session.resumeCursor).toEqual({
        threadId: "forked",
        retainedMetadata: "keep",
        rewindSourceThreadId: "old",
      });
      expect(send.mock.calls.at(-1)?.[1]).toBe("thread/turns/list");
    });
    expect(await manager.rollbackThread(id, 1, "drop", persist)).toEqual({
      threadId: "forked",
      turns: [{ id: "keep", items: [] }],
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "thread/revert",
      "thread/turns/list",
      "thread/rollback",
      "thread/fork",
      "thread/turns/list",
      "thread/unsubscribe",
      "thread/turns/list",
    ]);
    expect(send.mock.calls[3]?.[2]).toMatchObject({
      threadId: "old",
      beforeTurnId: "drop",
      excludeTurns: true,
      model: "gpt-5.3-codex",
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(send.mock.calls[3]?.[2]).not.toHaveProperty("experimentalRawEvents");
    expect(events.some((event) => event.threadId === id && event.textDelta === "early")).toBe(true);
    expect(context.legacyHistoryThreadIds.has("old")).toBe(false);
    send.mockResolvedValueOnce({ thread: { id: "forked" } }).mockResolvedValueOnce(page());
    await manager.rollbackThread(id, 1, "keep");
    expect(send.mock.calls[7]?.slice(1)).toEqual([
      "thread/revert",
      { threadId: "forked", beforeTurnId: "keep" },
    ]);
  });

  it.each(["valid", "mismatch", "save-failure"])(
    "validates changed revert identity before adoption: %s",
    async (scenario) => {
      const { manager, context, send } = harness();
      send
        .mockResolvedValueOnce({ thread: { id: "reloaded" } })
        .mockResolvedValueOnce(page("keep", "drop"))
        .mockResolvedValueOnce(page(scenario === "mismatch" ? "wrong" : "keep"));
      const persist = vi.fn(async (session: ProviderSession) => {
        expect(context.session.resumeCursor).toEqual({ threadId: "old", retainedMetadata: "keep" });
        expect(session.resumeCursor).toMatchObject({
          threadId: "reloaded",
          rewindSourceThreadId: "old",
        });
        if (scenario === "save-failure") throw new Error("save failed");
      });
      if (scenario === "valid") {
        expect(await manager.rollbackThread(id, 1, "drop", persist)).toEqual({
          threadId: "reloaded",
          turns: [{ id: "keep", items: [] }],
        });
        expect(context.session.resumeCursor).toMatchObject({
          threadId: "reloaded",
          rewindSourceThreadId: "old",
        });
      } else {
        await expect(manager.rollbackThread(id, 1, "drop", persist)).rejects.toThrow(
          scenario === "mismatch" ? "refusing adoption" : "save failed",
        );
        expect(context.session.resumeCursor).toEqual({ threadId: "old", retainedMetadata: "keep" });
      }
      expect(persist).toHaveBeenCalledTimes(scenario === "mismatch" ? 0 : 1);
    },
  );

  it.each([false, true])(
    "resolves an omitted boundary with cached flags (rollback absent=%s)",
    async (rollbackUnsupported) => {
      const { manager, context, send } = harness();
      context.revertUnsupported = true;
      context.rollbackUnsupported = rollbackUnsupported;
      send.mockResolvedValueOnce(page("keep", "drop"));
      if (rollbackUnsupported)
        send
          .mockResolvedValueOnce({ thread: { id: "forked" } })
          .mockResolvedValueOnce(page("keep"))
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce(page("keep"));
      else
        send.mockResolvedValueOnce({ thread: { id: "old", turns: [{ id: "keep", items: [] }] } });
      await manager.rollbackThread(id, 1);
      expect(send.mock.calls[1]?.[1]).toBe(rollbackUnsupported ? "thread/fork" : "thread/rollback");
      if (rollbackUnsupported)
        expect(send.mock.calls[1]?.[2]).toMatchObject({ beforeTurnId: "drop" });
    },
  );

  it("refuses adoption when fork history does not match", async () => {
    const { manager, context, send } = harness();
    context.revertUnsupported = context.rollbackUnsupported = true;
    send
      .mockResolvedValueOnce(page("keep", "drop"))
      .mockResolvedValueOnce({ thread: { id: "forked" } })
      .mockResolvedValueOnce(page("wrong"));
    const persist = vi.fn();
    await expect(manager.rollbackThread(id, 1, "drop", persist)).rejects.toThrow(
      "refusing adoption",
    );
    expect(context.session.resumeCursor).toEqual({ threadId: "old", retainedMetadata: "keep" });
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not expose a fork when cursor persistence fails", async () => {
    const { manager, context, send } = harness();
    context.revertUnsupported = context.rollbackUnsupported = true;
    send
      .mockResolvedValueOnce(page("keep", "drop"))
      .mockResolvedValueOnce({ thread: { id: "forked" } })
      .mockResolvedValueOnce(page("keep"));
    const persist = vi.fn(async () => {
      throw new Error("cursor save failed");
    });
    await expect(manager.rollbackThread(id, 1, "drop", persist)).rejects.toThrow(
      "cursor save failed",
    );
    expect(context.session.resumeCursor).toEqual({ threadId: "old", retainedMetadata: "keep" });
    expect(send.mock.calls.map((call) => call[1])).toEqual([
      "thread/turns/list",
      "thread/fork",
      "thread/turns/list",
    ]);
  });

  it("reports event overflow as a possible orphan without adopting", async () => {
    const { manager, context, send, notify } = harness();
    context.revertUnsupported = context.rollbackUnsupported = true;
    send
      .mockResolvedValueOnce(page("keep", "drop"))
      .mockImplementationOnce(async () => {
        for (let i = 0; i < 513; i++)
          notify("item/agentMessage/delta", {
            threadId: "child",
            turnId: "child-turn",
            itemId: "child-item",
            delta: "child",
          });
        return { thread: { id: "forked" } };
      })
      .mockResolvedValueOnce(page("keep"));
    const persist = vi.fn();
    await expect(manager.rollbackThread(id, 1, "drop", persist)).rejects.toThrow(
      "possible orphan forked",
    );
    expect(persist).not.toHaveBeenCalled();
    expect(context.session.resumeCursor).toEqual({ threadId: "old", retainedMetadata: "keep" });
  });

  it("blocks further rewinds after losing a fork response", async () => {
    const { manager, context, send } = harness();
    context.revertUnsupported = context.rollbackUnsupported = true;
    send.mockResolvedValueOnce(page("drop")).mockRejectedValueOnce(new Error("transport lost"));
    await expect(manager.rollbackThread(id, 1)).rejects.toThrow("transport lost");
    await expect(manager.rollbackThread(id, 1)).rejects.toThrow("orphan");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retains the persisted cursor when the final read fails", async () => {
    const { manager, context, send } = harness();
    context.revertUnsupported = context.rollbackUnsupported = true;
    send
      .mockResolvedValueOnce(page("keep", "drop"))
      .mockResolvedValueOnce({ thread: { id: "forked" } })
      .mockResolvedValueOnce(page("keep"))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("final read failed"));
    const persist = vi.fn(async () => {});
    await expect(manager.rollbackThread(id, 1, "drop", persist)).rejects.toThrow(
      "final read failed",
    );
    expect(context.session.resumeCursor).toEqual({
      threadId: "forked",
      retainedMetadata: "keep",
      rewindSourceThreadId: "old",
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
