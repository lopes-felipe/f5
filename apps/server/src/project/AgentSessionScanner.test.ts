import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderInstanceId,
  ImportedSessionMessages,
  IMPORTED_SESSION_MESSAGE_MAX_CHARS,
  IMPORTED_SESSION_THREAD_MAX_CHARS,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { AgentSessionScanner } from "./AgentSessionScanner";
import { parseAgentSessionTranscript } from "./agentSessionTranscript";

const roots: string[] = [];
const sessionId = "11111111-1111-4111-8111-111111111111";
const instanceId = ProviderInstanceId.make("codex");
const jsonl = (...records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "f5-agent-import-")));
  roots.push(root);
  const cwd = join(root, "repository");
  const home = join(root, "codex");
  const file = join(home, "sessions", "rollout.jsonl");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(
    file,
    jsonl(
      { type: "session_meta", payload: { id: sessionId, cwd } },
      { type: "event_msg", payload: { type: "user_message", message: "Fix the bug" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Fixed" }],
        },
      },
    ),
  );
  return { root, cwd, home, file, source: { provider: "codex" as const, instanceId, home } };
}
describe("agent project discovery", () => {
  it("discovers projects with large first metadata records and flags records beyond the cap", async () => {
    const f = await fixture();
    const contents = (length: number) =>
      jsonl({
        type: "session_meta",
        payload: { id: sessionId, cwd: f.cwd, instructions: "x".repeat(length) },
      });
    await writeFile(f.file, contents(300 * 1024));
    const scanner = new AgentSessionScanner();
    const scan = () =>
      scanner.scan([f.source], [], join(f.root, "worktrees"), new AbortController().signal);
    expect((await scan()).candidates).toHaveLength(1);
    await writeFile(f.file, contents(1100 * 1024));
    const oversized = await scan();
    expect(oversized.candidates).toHaveLength(0);
    expect(oversized.truncated).toBe(true);
  });

  it("renews an active scan for later selected projects but still expires abandoned scans", async () => {
    const f = await fixture();
    const secondRoot = join(f.root, "second");
    await mkdir(secondRoot);
    await writeFile(
      join(f.home, "sessions", "second.jsonl"),
      jsonl({
        type: "session_meta",
        payload: { id: "22222222-2222-4222-8222-222222222222", cwd: secondRoot },
      }),
    );
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const scanner = new AgentSessionScanner();
    const result = await scanner.scan(
      [f.source],
      [],
      join(f.root, "worktrees"),
      new AbortController().signal,
    );
    const first = result.candidates.find((candidate) => candidate.path === f.cwd)!;
    const second = result.candidates.find((candidate) => candidate.path === secondRoot)!;
    now += 9 * 60_000;
    scanner.keepAlive(scanner.get(first.id, first.path));
    now += 9 * 60_000;
    expect(scanner.get(second.id, second.path).summary.path).toBe(secondRoot);
    now += 11 * 60_000;
    expect(() => scanner.get(second.id, second.path)).toThrow("Scan for projects again");
  });

  it("uses a Claude filename UUID for both discovery and import of mixed-session history", async () => {
    const f = await fixture();
    const directory = join(f.root, "claude", "projects", "repository");
    await mkdir(directory, { recursive: true });
    const otherId = "22222222-2222-4222-8222-222222222222";
    await writeFile(
      join(directory, sessionId + ".jsonl"),
      jsonl(
        { type: "user", sessionId: otherId, cwd: f.cwd, message: { content: "Forked prompt" } },
        { type: "assistant", sessionId, message: { content: "Reply" } },
        { type: "assistant", sessionId: otherId, message: { content: "Later reply" } },
      ),
    );
    const scanner = new AgentSessionScanner();
    const scan = await scanner.scan(
      [{ provider: "claudeAgent", instanceId, home: join(f.root, "claude") }],
      [],
      join(f.root, "worktrees"),
      new AbortController().signal,
    );
    const candidate = scanner.get(scan.candidates[0]!.id, f.cwd);
    expect(candidate.transcripts[0]?.sessionId).toBe(sessionId);
    const history = await scanner.read(
      candidate.transcripts[0]!,
      f.cwd,
      new AbortController().signal,
    );
    expect(history?.providerSessionId).toBe(sessionId);
    expect(history?.messages.map((message) => message.text)).toEqual([
      "Forked prompt",
      "Reply",
      "Later reply",
    ]);
  });

  it("bounds imported text, preserves the first prompt and newest reply, and validates the budget", () => {
    const text = "x".repeat(IMPORTED_SESSION_MESSAGE_MAX_CHARS + 1000);
    const history = parseAgentSessionTranscript({
      contents: jsonl(
        { type: "session_meta", payload: { id: sessionId } },
        { type: "event_msg", payload: { type: "user_message", message: "Original prompt" } },
        ...Array.from({ length: 20 }, (_, index) => ({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: index + text }],
          },
        })),
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Newest reply" }],
          },
        },
      ),
      source: "codex",
      providerInstanceId: instanceId,
      fallbackSessionId: "rollout",
      lastActiveAtMs: Date.now(),
    })!;
    expect(history.truncated).toBe(true);
    expect(history.messages[0]?.text).toBe("Original prompt");
    expect(history.messages.at(-1)?.text).toBe("Newest reply");
    expect(
      history.messages.some((message) =>
        message.text.endsWith("[History shortened during import]"),
      ),
    ).toBe(true);
    expect(
      history.messages.every(
        (message) => message.text.length <= IMPORTED_SESSION_MESSAGE_MAX_CHARS,
      ),
    ).toBe(true);
    expect(
      history.messages.reduce((total, message) => total + message.text.length, 0),
    ).toBeLessThanOrEqual(IMPORTED_SESSION_THREAD_MAX_CHARS);
    expect(Schema.is(ImportedSessionMessages)(history.messages)).toBe(true);
    expect(Schema.is(ImportedSessionMessages)([{ ...history.messages[0], text }])).toBe(false);
    expect(
      Schema.is(ImportedSessionMessages)(
        Array.from({ length: 9 }, () => ({
          ...history.messages[0],
          text: text.slice(0, IMPORTED_SESSION_MESSAGE_MAX_CHARS),
        })),
      ),
    ).toBe(false);
  });

  it("discovers configured histories, marks existing projects, and reads resumable messages", async () => {
    const f = await fixture();
    const scanner = new AgentSessionScanner();
    const result = await scanner.scan(
      [f.source],
      [f.cwd],
      join(f.root, "worktrees"),
      new AbortController().signal,
    );
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate).toMatchObject({
      path: f.cwd,
      threadCount: 1,
      alreadyImported: true,
      sources: ["codex"],
    });
    const selected = scanner.get(candidate.id, candidate.path);
    const history = await scanner.read(
      selected.transcripts[0]!,
      f.cwd,
      new AbortController().signal,
    );
    expect(history?.providerSessionId).toBe(sessionId);
    expect(history?.messages.map((message) => message.text)).toEqual(["Fix the bug", "Fixed"]);
    expect(() => scanner.get(candidate.id, "/another-project")).toThrow("Scan for projects again");
  });
  it("skips symlinks and app-owned worktrees, and refuses changed transcripts", async () => {
    const f = await fixture();
    await symlink(f.file, join(f.home, "sessions", "linked.jsonl"));
    const scanner = new AgentSessionScanner();
    const result = await scanner.scan(
      [f.source],
      [],
      join(f.root, "elsewhere"),
      new AbortController().signal,
    );
    const selected = scanner.get(result.candidates[0]!.id, f.cwd);
    expect(selected.transcripts).toHaveLength(1);
    await writeFile(f.file, "changed");
    await expect(
      scanner.read(selected.transcripts[0]!, f.cwd, new AbortController().signal),
    ).rejects.toThrow("changed");
    const fresh = await fixture();
    const filtered = await scanner.scan(
      [fresh.source],
      [],
      fresh.cwd,
      new AbortController().signal,
    );
    expect(filtered.candidates).toEqual([]);
  });
  it("reports an oversized source without reading it and respects cancellation", async () => {
    const f = await fixture();
    const handle = await open(f.file, "r+");
    await handle.truncate(17 * 1024 * 1024);
    await handle.close();
    const scanner = new AgentSessionScanner();
    const result = await scanner.scan(
      [f.source],
      [],
      join(f.root, "elsewhere"),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ candidates: [], truncated: true });
    const controller = new AbortController();
    controller.abort();
    await expect(scanner.scan([f.source], [], f.root, controller.signal)).rejects.toThrow();
  });
});

describe("imported transcript text", () => {
  it("removes Claude CLI markup and ignores tool/meta/sidechain rows", () => {
    const history = parseAgentSessionTranscript({
      contents: jsonl(
        {
          type: "user",
          sessionId,
          message: { content: "<local-command-caveat>local CLI</local-command-caveat>" },
        },
        {
          type: "user",
          sessionId,
          message: {
            content: "<command-name>/review</command-name><command-args>the diff</command-args>",
          },
        },
        { type: "user", sessionId, isMeta: true, message: { content: "not a prompt" } },
        {
          type: "assistant",
          sessionId,
          isSidechain: true,
          message: { content: "not a main reply" },
        },
        {
          type: "assistant",
          sessionId,
          message: {
            content: [
              { type: "text", text: "Reviewed" },
              { type: "tool_use", text: "not text" },
            ],
          },
        },
      ),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: sessionId,
      lastActiveAtMs: Date.now(),
    });
    expect(history?.messages.map((message) => message.text)).toEqual([
      "/review the diff",
      "Reviewed",
    ]);
    expect(history?.title).toBe("the diff");
  });
  it("keeps slash and shell input, hides CLI output, and preserves clean custom titles", () => {
    const history = parseAgentSessionTranscript({
      contents: jsonl(
        { type: "user", message: { content: "<command-message>clear</command-message>" } },
        { type: "user", message: { content: "<bash-input>npm test</bash-input>" } },
        { type: "user", message: { content: "<bash-stdout>passed</bash-stdout>" } },
        { type: "user", message: { content: "<task-notification>done</task-notification>" } },
        { type: "user", message: { content: "[Request interrupted by user for tool use]" } },
        { type: "user", message: { content: "Fix the login flow" } },
        { type: "assistant", message: { content: "Fixed" } },
        { type: "custom-title", customTitle: "My login work" },
        { type: "ai-title", aiTitle: "<command-name>/clear</command-name>" },
      ),
      source: "claudeAgent",
      providerInstanceId: instanceId,
      fallbackSessionId: sessionId,
      lastActiveAtMs: Date.now(),
    });
    expect(history?.messages.map((message) => message.text)).toEqual([
      "/clear",
      "!npm test",
      "Fix the login flow",
      "Fixed",
    ]);
    expect(history?.title).toBe("My login work");
  });
  it.each([false, true])(
    "imports a bare Claude command only after an assistant reply: %s",
    (answered) => {
      const history = parseAgentSessionTranscript({
        contents: jsonl(
          { type: "user", message: { content: "<command-name>/review</command-name>" } },
          ...(answered ? [{ type: "assistant", message: { content: "Found an issue" } }] : []),
        ),
        source: "claudeAgent",
        providerInstanceId: instanceId,
        fallbackSessionId: sessionId,
        lastActiveAtMs: Date.now(),
      });
      expect(history?.title ?? null).toBe(answered ? "/review" : null);
    },
  );
  it("retains the first prompt and bounded recent messages and rejects non-resumable Codex rows", () => {
    const records = [
      { type: "session_meta", payload: { id: sessionId } },
      ...Array.from({ length: 250 }, (_, index) => ({
        type: "event_msg",
        payload: { type: "user_message", message: "prompt " + index },
      })),
    ];
    const input = {
      contents: jsonl(...records),
      source: "codex" as const,
      providerInstanceId: instanceId,
      fallbackSessionId: "rollout",
      lastActiveAtMs: Date.now(),
    };
    const history = parseAgentSessionTranscript(input);
    expect(history?.messages).toHaveLength(200);
    expect(history?.messages[0]?.text).toBe("prompt 0");
    expect(history?.messages.at(-1)?.text).toBe("prompt 249");
    expect(
      parseAgentSessionTranscript({ ...input, contents: jsonl(...records.slice(1)) }),
    ).toBeNull();
  });
});
