import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderInstanceId } from "@t3tools/contracts";
import { AgentSessionScanner } from "./AgentSessionScanner";
import { parseAgentSessionTranscript } from "./agentSessionTranscript";

const roots: string[] = [];
const sessionId = "11111111-1111-4111-8111-111111111111";
const instanceId = ProviderInstanceId.make("codex");
const jsonl = (...records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
afterEach(async () => {
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
