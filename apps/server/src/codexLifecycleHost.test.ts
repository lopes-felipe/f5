import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ThreadId, type ProviderEvent } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { CodexAppServerManager } from "./codexAppServerManager.ts";

it("streams, approves, interrupts and resumes the desktop's real stdio fixture", async () => {
  const home = mkdtempSync(join(tmpdir(), "f5-codex-lifecycle-"));
  const manager = new CodexAppServerManager();
  const events: ProviderEvent[] = [];
  manager.on("event", (event) => events.push(event));
  const threadId = ThreadId.makeUnsafe("lifecycle-thread");
  const options = {
    threadId,
    provider: "codex" as const,
    cwd: home,
    runtimeMode: "full-access" as const,
    providerOptions: {
      codex: {
        binaryPath: fileURLToPath(
          new URL("../../../scripts/fixtures/codex-lifecycle-host.mjs", import.meta.url),
        ),
        homePath: home,
      },
    },
  };
  try {
    const session = await manager.startSession(options);
    const turn = await manager.sendTurn({ threadId, input: "F5_SMOKE_APPROVAL" });
    await vi.waitFor(() => expect(events.some((event) => event.requestId)).toBe(true));
    expect(events.some((event) => event.method === "item/agentMessage/delta")).toBe(false);
    await manager.respondToRequest(
      threadId,
      events.find((event) => event.requestId)!.requestId!,
      "accept",
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.method === "item/agentMessage/delta")).toBe(true),
    );
    await manager.interruptTurn(threadId, turn.turnId);
    await vi.waitFor(() =>
      expect(events.some((event) => event.method === "turn/completed")).toBe(true),
    );
    const before = await manager.readThread(threadId);
    expect(before.turns).toHaveLength(1);
    expect(JSON.stringify(before.turns[0])).toContain("Desktop stream 1");
    const resumed = await manager.startSession({ ...options, resumeCursor: session.resumeCursor });
    expect(resumed.resumeCursor).toMatchObject(session.resumeCursor!);
    expect((await manager.readThread(threadId)).turns).toEqual(before.turns);
    const streaming = await manager.sendTurn({ threadId, input: "F5_SMOKE_STREAM" });
    await vi.waitFor(async () =>
      expect((await manager.readThread(threadId)).turns).toHaveLength(2),
    );
    await manager.interruptTurn(threadId, streaming.turnId);
    await manager.sendTurn({ threadId, input: "Generate a title for F5_SMOKE_STREAM quit" });
    await vi.waitFor(() =>
      expect(events.filter((event) => event.method === "turn/completed")).toHaveLength(3),
    );
  } finally {
    await manager.shutdown(Date.now() + 1_800);
    expect(manager.listSessions()).toHaveLength(0);
    manager.removeAllListeners();
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
