import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ThreadId, AgentTranscriptPage, ProviderInstanceId } from "@t3tools/contracts";
import { Schema, Effect, Option } from "effect";
import { readAgentTranscript } from "./readAgentTranscript.ts";
import { backgroundWorkSessionIdentity } from "../backgroundWorkIdentity.ts";
import { decodeCursor, encodeCursor } from "./agentTranscriptCursor.ts";
import { readClaudeAgentTranscript } from "./readClaudeAgentTranscript.ts";
import { resolveClaudeSubagentFile } from "./claudeSubagentTranscript.ts";
import { normalizeClaudeSubagentRecord } from "./normalizeClaudeSubagentRecord.ts";
import { normalizeCodexThreadItem, readCodexAgentTranscript } from "./readCodexAgentTranscript.ts";
import { readBoundedJsonlLines } from "./boundedJsonl.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-transcript-"));
  roots.push(configDir);
  const sessionId = "12345678-1234-4234-8234-123456789abc",
    agentId = "a123";
  const project = path.join(configDir, "projects", "test");
  const directory = path.join(project, sessionId, "subagents");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(project, sessionId + ".jsonl"), "");
  const file = path.join(directory, "agent-" + agentId + ".jsonl");
  await fs.writeFile(file, "");
  return { configDir, sessionId, agentId, active: true, file, directory };
}
const input = { threadId: ThreadId.makeUnsafe("thread-1"), workItemIds: ["a123"], limit: 2 };
const record = (n: number) =>
  JSON.stringify({
    type: "assistant",
    uuid: "m" + n,
    message: { content: [{ type: "text", text: "message " + n }] },
  }) + "\n";
describe("agent transcripts", () => {
  it.each([false, true])(
    "routes the grouped Codex child row in either order (%s)",
    async (reverse) => {
      const row = {
        workItemId: "subagent:child-thread",
        provider: "codex" as const,
        providerInstanceId: ProviderInstanceId.makeUnsafe("codex-account"),
        kind: "agent" as const,
        active: true,
        status: "running" as const,
        nativeParentSessionId: null,
        providerSessionIdentity: "session",
      };
      const rows = [{ ...row, workItemId: "call-spawn" }, row];
      const read = vi.fn(() =>
        Effect.succeed({
          kind: "page" as const,
          data: [{ id: "child-message", type: "agentMessage", text: "child output" }],
          nextCursor: null,
        }),
      );
      const result = await Effect.runPromise(
        readAgentTranscript(
          { ...input, workItemIds: rows.map((row) => row.workItemId) },
          {
            work: { getOwnedEntries: () => Effect.succeed(reverse ? rows.toReversed() : rows) },
            directory: { getBinding: () => Effect.succeed(Option.none()) },
            service: { readChildThreadItems: read },
            resolveAccount: async () => {
              throw new Error("Codex must not resolve Claude accounts");
            },
          },
        ),
      );
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: input.threadId,
          childId: "child-thread",
          providerInstanceId: row.providerInstanceId,
        }),
      );
      expect(result.items[0]?.id).toBe("child-message");
    },
  );
  it("round-trips exact Windows file identities above the safe integer limit", () => {
    const cursor = {
      v: 1,
      p: "claude",
      dir: "fwd",
      o: 100,
      ino: String(18014398509481985n),
      dev: String(9007199254740993n),
    } as const;
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
  it("bounds a first Claude record after JSON escaping without skipping the next record", async () => {
    const f = await fixture();
    const large =
      JSON.stringify({
        type: "assistant",
        uuid: "large",
        message: {
          content: Array.from({ length: 64 }, (_, i) => ({
            type: "text",
            text: i === 0 ? "short" : "\u0001".repeat(2745),
          })),
        },
      }) + "\n";
    expect(Buffer.byteLength(large)).toBeLessThan(1024 * 1024);
    await fs.writeFile(f.file, large + record(1));
    const first = await readClaudeAgentTranscript({ ...input, anchor: "start", limit: 64 }, f);
    expect(first.items).toHaveLength(64);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024);
    expect(first.items[0]).toMatchObject({ id: "large:0", truncated: false });
    expect(first.items[1]).toMatchObject({ truncated: true });
    const next = await readClaudeAgentTranscript({ ...input, cursor: first.nextCursor! }, f);
    expect(next.items[0]?.id).toBe("m1:0");
  });
  it("opens a large transcript using only a tail chunk", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, "x".repeat(9 * 1024 * 1024) + "\n" + record(1));
    const file = await fs.open(f.file, "r");
    try {
      const read = vi.spyOn(file, "read");
      for await (const line of readBoundedJsonlLines(file, {
        start: (await file.stat()).size,
        dir: "back",
        maxLineBytes: 1024 * 1024,
      })) {
        expect(line.text).toContain("message 1");
        break;
      }
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await file.close();
    }
  });
  it("honors negative resolution entries for five seconds", async () => {
    const f = await fixture();
    await fs.unlink(f.file);
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    expect((await readClaudeAgentTranscript(input, f)).reason).toBe("not-started");
    await fs.writeFile(f.file, record(0));
    expect((await readClaudeAgentTranscript(input, f)).reason).toBe("not-started");
    now.mockReturnValue(15001);
    expect((await readClaudeAgentTranscript(input, f)).items[0]?.id).toBe("m0:0");
  });
  it("revalidates a cached canonical directory after replacement by a symlink", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, record(0));
    await readClaudeAgentTranscript(input, f);
    const other = path.join(f.configDir, "other");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, path.basename(f.file)), record(99));
    await fs.rename(f.directory, f.directory + ".original");
    await fs.symlink(other, f.directory);
    await expect(readClaudeAgentTranscript(input, f)).rejects.toThrow(
      "Invalid isolated transcript",
    );
  });
  it("marks only fields actually shortened by the page budget as truncated", async () => {
    const result = await Effect.runPromise(
      readCodexAgentTranscript({ ...input, limit: 200 }, () =>
        Effect.succeed({
          kind: "page" as const,
          nextCursor: null,
          data: [
            { id: "short", type: "agentMessage", text: "short" },
            ...Array.from({ length: 49 }, (_, i) => ({
              id: String(i),
              type: "agentMessage",
              text: "x".repeat(100000),
            })),
          ],
        }),
      ),
    );
    expect(result.items[0]).toMatchObject({ id: "short", truncated: false });
    expect(result.items[1]).toMatchObject({ truncated: true });
  });
  it("traverses terminated records larger than the scan budget in both directions", async () => {
    const f = await fixture();
    await fs.writeFile(
      f.file,
      record(0) + JSON.stringify({ output: "x".repeat(9 * 1024 * 1024) }) + "\n" + record(1),
    );
    let page = await readClaudeAgentTranscript({ ...input, anchor: "start", limit: 1 }, f);
    expect(page.items[0]?.id).toBe("m0:0");
    page = await readClaudeAgentTranscript({ ...input, cursor: page.nextCursor!, limit: 1 }, f);
    expect(page.items).toMatchObject([{ kind: "notice", text: "Record too large to display" }]);
    const noticeId = page.items[0]!.id;
    page = await readClaudeAgentTranscript({ ...input, cursor: page.nextCursor!, limit: 1 }, f);
    expect(page.items[0]?.id).toBe("m1:0");
    page = await readClaudeAgentTranscript({ ...input, limit: 1 }, f);
    expect(page.items[0]?.id).toBe("m1:0");
    page = await readClaudeAgentTranscript({ ...input, cursor: page.earlierCursor!, limit: 1 }, f);
    expect(page.items[0]?.id).toBe(noticeId);
    page = await readClaudeAgentTranscript({ ...input, cursor: page.earlierCursor!, limit: 1 }, f);
    expect(page.items[0]?.id).toBe("m0:0");
    expect(page.earlierCursor).toBeNull();
  });
  it("skips blank lines without displaying malformed-record notices", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, "\n\r\n" + record(0) + "\n");
    const page = await readClaudeAgentTranscript({ ...input, anchor: "start" }, f);
    expect(page.items.map((item) => item.id)).toEqual(["m0:0"]);
  });
  it.each(["completed", "success", "cancelled", "interrupted", undefined])(
    "settles native Codex status %s",
    (status) => {
      expect(
        normalizeCodexThreadItem({ id: "t", type: "webSearch", status }, "fallback")[0],
      ).toMatchObject({ status: "completed" });
    },
  );
  it.each(["failed", "error", "denied", "declined"])(
    "marks native Codex status %s as failed",
    (status) => {
      expect(
        normalizeCodexThreadItem({ id: "t", type: "commandExecution", status }, "fallback")[0],
      ).toMatchObject({ status: "failed" });
    },
  );
  it("carries an active first-page floor through catch-up and rereads it", async () => {
    const reads: Array<string | null> = [];
    let active = true;
    const read = (cursor: string | null) => {
      reads.push(cursor);
      const index = cursor ? Number(cursor.slice(1)) : 0;
      return Effect.succeed({
        kind: "page" as const,
        nextCursor: index < 6 ? "p" + (index + 1) : null,
        data: [
          index === 0
            ? {
                id: "tool",
                type: "commandExecution",
                status: active ? "inProgress" : "completed",
                command: "pwd",
              }
            : { id: "m" + index, type: "agentMessage", text: "message" },
        ],
      });
    };
    let result = await Effect.runPromise(readCodexAgentTranscript({ ...input, limit: 200 }, read));
    expect(result.nextCursor).not.toBeNull();
    result = await Effect.runPromise(
      readCodexAgentTranscript({ ...input, limit: 200, cursor: result.nextCursor! }, read),
    );
    const tail = result.tailCursor!;
    reads.length = 0;
    result = await Effect.runPromise(
      readCodexAgentTranscript({ ...input, limit: 200, cursor: tail }, read),
    );
    expect(reads).toEqual([null, "p1", "p2", "p3"]);
    expect(result.items.map((item) => item.id)).toEqual(["tool", "m1", "m2", "m3"]);
    expect(result.items[1]?.position).toEqual({ offset: 1, index: 0 });
    active = false;
    reads.length = 0;
    result = await Effect.runPromise(
      readCodexAgentTranscript({ ...input, limit: 200, cursor: tail }, read),
    );
    expect(reads[0]).toBeNull();
    expect(result.items[0]).toMatchObject({ id: "tool", status: "completed" });
    while (result.nextCursor)
      result = await Effect.runPromise(
        readCodexAgentTranscript({ ...input, limit: 200, cursor: result.nextCursor }, read),
      );
    expect(reads).toEqual([null, "p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(decodeCursor(result.tailCursor!)).toMatchObject({ floor: null });
  });
  it("bounds a native page only after preserving normalized item metadata", async () => {
    const result = await Effect.runPromise(
      readCodexAgentTranscript({ ...input, limit: 200 }, () =>
        Effect.succeed({
          kind: "page" as const,
          nextCursor: null,
          data: Array.from({ length: 50 }, (_, index) => ({
            id: String(index),
            type: "agentMessage",
            text: "x".repeat(100000),
          })),
        }),
      ),
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
    expect(result.items).toHaveLength(50);
  });
  it("uses the owned row's original session and account after its binding changes", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, record(1));
    const account = ProviderInstanceId.makeUnsafe("claude-original");
    const seen: string[] = [];
    const row = {
      workItemId: "a123",
      provider: "claudeAgent" as const,
      providerInstanceId: account,
      kind: "agent" as const,
      active: false,
      status: "completed" as const,
      nativeParentSessionId: f.sessionId,
      providerSessionIdentity: "original-generation",
    };
    const deps = {
      work: {
        getOwnedEntries: (request: { workItemIds: readonly string[] }) =>
          Effect.succeed(request.workItemIds.includes("a123") ? [row] : []),
      },
      directory: {
        getBinding: () =>
          Effect.succeed(
            Option.some({
              threadId: input.threadId,
              provider: "codex" as const,
              providerInstanceId: ProviderInstanceId.makeUnsafe("replacement"),
              lastSeenAt: "2026-01-01T00:00:00Z",
            }),
          ),
      },
      service: {},
      resolveAccount: async (id: ProviderInstanceId) => {
        seen.push(id);
        return { environment: { CLAUDE_CONFIG_DIR: f.configDir } };
      },
    };
    const result = await Effect.runPromise(
      readAgentTranscript({ ...input, workItemIds: ["a123", "foreign", "toolu_foreign"] }, deps),
    );
    expect(result.items[0]?.id).toBe("m1:0");
    expect(seen).toEqual([account]);
    expect(
      (await Effect.runPromise(readAgentTranscript({ ...input, workItemIds: ["foreign"] }, deps)))
        .reason,
    ).toBe("not-found");
    const legacy = {
      ...deps,
      work: { getOwnedEntries: () => Effect.succeed([{ ...row, nativeParentSessionId: null }]) },
    };
    expect((await Effect.runPromise(readAgentTranscript(input, legacy))).reason).toBe(
      "identity-unavailable",
    );
    const binding = {
      threadId: input.threadId,
      provider: "claudeAgent" as const,
      providerInstanceId: account,
      resumeCursor: { resume: f.sessionId },
      lastSeenAt: "2026-01-01T00:00:00Z",
    };
    const sameInstance = {
      ...deps,
      work: {
        getOwnedEntries: () =>
          Effect.succeed([
            {
              ...row,
              nativeParentSessionId: null,
              providerSessionIdentity: backgroundWorkSessionIdentity(binding),
            },
          ]),
      },
      directory: { getBinding: () => Effect.succeed(Option.some(binding)) },
    };
    expect((await Effect.runPromise(readAgentTranscript(input, sameInstance))).items[0]?.id).toBe(
      "m1:0",
    );
    const replacedInstance = {
      ...sameInstance,
      directory: {
        getBinding: () =>
          Effect.succeed(Option.some({ ...binding, launchFingerprint: "replacement-launch" })),
      },
    };
    expect((await Effect.runPromise(readAgentTranscript(input, replacedInstance))).reason).toBe(
      "identity-unavailable",
    );
  });
  it("validates cursor shape without accepting extra identity or paths", () => {
    expect(() =>
      decodeCursor(
        Buffer.from(
          JSON.stringify({ v: 1, p: "codex", c: null, floor: null, path: "/tmp/private" }),
        ).toString("base64url"),
      ),
    ).toThrow();
    const cursor = { v: 1, p: "claude", dir: "fwd", o: 0, ino: 1, dev: 1 } as const;
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });
  it("pages backward and forward without skipping records", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, Array.from({ length: 7 }, (_, n) => record(n)).join(""));
    const forward: string[] = [],
      backward: string[] = [];
    let page = await readClaudeAgentTranscript({ ...input, anchor: "start" }, f);
    forward.push(...page.items.map((item) => item.id));
    while (page.nextCursor) {
      page = await readClaudeAgentTranscript({ ...input, cursor: page.nextCursor }, f);
      forward.push(...page.items.map((item) => item.id));
    }
    page = await readClaudeAgentTranscript(input, f);
    backward.unshift(...page.items.map((item) => item.id));
    while (page.earlierCursor) {
      page = await readClaudeAgentTranscript({ ...input, cursor: page.earlierCursor }, f);
      backward.unshift(...page.items.map((item) => item.id));
    }
    expect(forward).toEqual(backward);
    expect(new Set(forward).size).toBe(7);
    expect(Schema.is(AgentTranscriptPage)(page)).toBe(true);
  });
  it("does not consume a partial record, then picks it up after append", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, record(0) + record(1).slice(0, -1));
    const page = await readClaudeAgentTranscript(input, f);
    expect(page.pendingTail).toBe(true);
    expect(page.items).toHaveLength(1);
    await fs.appendFile(f.file, "\n");
    const next = await readClaudeAgentTranscript({ ...input, cursor: page.tailCursor! }, f);
    expect(next.items[0]?.id).toBe("m1:0");
  });
  it("resets mid-line, replacement and out-of-range cursors", async () => {
    const f = await fixture();
    await fs.writeFile(f.file, record(0));
    const stat = await fs.stat(f.file, { bigint: true });
    for (const extra of [{ o: 1 }, { o: Number(stat.size) + 5 }, { ino: String(stat.ino + 1n) }]) {
      const cursor = encodeCursor({
        v: 1,
        p: "claude",
        dir: "fwd",
        o: 0,
        ino: String(stat.ino),
        dev: String(stat.dev),
        ...extra,
      });
      expect((await readClaudeAgentTranscript({ ...input, cursor }, f)).reset).toBe(true);
    }
  });
  it("rejects symlinked files and escaping directories", async () => {
    const f = await fixture();
    const other = path.join(f.configDir, "other");
    await fs.writeFile(other, "");
    await fs.unlink(f.file);
    await fs.symlink(other, f.file);
    await expect(resolveClaudeSubagentFile(f)).rejects.toThrow();
  });
  it("reports missing files by live state", async () => {
    const f = await fixture();
    await fs.unlink(f.file);
    expect((await readClaudeAgentTranscript(input, f)).reason).toBe("not-started");
    expect((await readClaudeAgentTranscript(input, { ...f, active: false })).reason).toBe(
      "not-found",
    );
  });
  it("normalizes calls and results, thinking and compaction", () => {
    const call = normalizeClaudeSubagentRecord(
      {
        type: "assistant",
        uuid: "a",
        message: {
          content: [
            { type: "thinking", thinking: "" },
            { type: "tool_use", id: "t", name: "Bash", input: { command: "pwd" } },
          ],
        },
      },
      0,
    );
    expect(call).toMatchObject([
      { id: "a:1", kind: "tool-call", toolCallId: "t", itemType: "command_execution" },
    ]);
    expect(
      normalizeClaudeSubagentRecord(
        {
          type: "user",
          uuid: "u",
          message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
        },
        1,
      ),
    ).toMatchObject([{ kind: "tool-result", output: "ok" }]);
    expect(normalizeClaudeSubagentRecord({ type: "attachment" }, 2)).toEqual([]);
    expect(
      normalizeClaudeSubagentRecord({ type: "system", subtype: "compact_boundary" }, 3)[0]?.kind,
    ).toBe("notice");
  });
  it("keeps command metadata when Codex output is huge", () => {
    expect(
      normalizeCodexThreadItem(
        {
          id: "cmd",
          type: "commandExecution",
          command: "pwd",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "x".repeat(100000),
        },
        "fallback",
      ),
    ).toMatchObject([
      { id: "cmd", kind: "tool-call", detail: "pwd", status: "completed", outputTruncated: true },
    ]);
  });
});
