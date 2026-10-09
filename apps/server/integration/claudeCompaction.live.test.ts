import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  getSessionMessages,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import { createControllableAsyncIterable } from "../src/provider/Layers/ClaudeSdk.testUtils.ts";
import { deleteClaudeSessionTranscript } from "../src/provider/claudeSessionCleanup.ts";

// Explicit opt-in. Authentication failures fail instead of silently skipping certification.
describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")(
  "Claude native compaction acceptance",
  () => {
    it("emits a compact boundary and preserves context through two resumes", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "f5-claude-compact-"));
      const sessionId = randomUUID();
      const sentinel = `F5_COMPACT_${randomUUID().replaceAll("-", "")}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 170_000);
      async function run(resume: boolean, prompts: string[]) {
        const input = createControllableAsyncIterable<SDKUserMessage>();
        const abort = new AbortController();
        const cancelled = () => abort.abort();
        controller.signal.addEventListener("abort", cancelled, { once: true });
        if (controller.signal.aborted) abort.abort();
        const runtime = query({
          prompt: input.iterable,
          options: {
            cwd,
            ...(resume ? { resume: sessionId } : { sessionId }),
            model: process.env.F5_CLAUDE_COMPACTION_MODEL ?? "claude-fable-5-1",
            env: buildClaudeQueryEnv(undefined, process.env),
            tools: [],
            permissionMode: "default",
            settingSources: [],
            abortController: abort,
          },
        });
        const turns: SDKMessage[][] = [];
        try {
          await runtime.initializationResult();
          for (const text of prompts) {
            input.push({
              type: "user",
              session_id: sessionId,
              parent_tool_use_id: null,
              uuid: randomUUID(),
              message: { role: "user", content: text },
            });
            const messages: SDKMessage[] = [];
            for (;;) {
              const next = await runtime.next();
              expect(next.done, "Claude exited before settling the turn").toBe(false);
              if (next.done) throw new Error("Claude exited before settling the turn");
              messages.push(next.value);
              if (next.value.type === "result") {
                const failure =
                  "errors" in next.value ? next.value.errors.join(", ") : next.value.result;
                expect(next.value.is_error, failure.slice(0, 1024)).toBe(false);
                break;
              }
            }
            turns.push(messages);
          }
          return turns;
        } finally {
          controller.signal.removeEventListener("abort", cancelled);
          input.end();
          abort.abort();
          runtime.close();
        }
      }
      try {
        const turns = await run(false, [
          `Remember this important project recovery token for future turns and summaries: ${sentinel}. Reply READY.`,
          "/compact",
        ]);
        expect(turns[1]?.some((m) => m.type === "system" && m.subtype === "compact_boundary")).toBe(
          true,
        );
        expect((await getSessionMessages(sessionId, { dir: cwd })).length).toBeGreaterThan(0);
        for (let attempt = 0; attempt < 2; attempt++) {
          const [messages] = await run(true, [
            "Reply with the exact project recovery token from earlier, and nothing else.",
          ]);
          const text = messages!
            .flatMap((m) =>
              m.type === "assistant"
                ? m.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
                : [],
            )
            .join("\n");
          expect(text).toContain(sentinel);
        }
      } finally {
        clearTimeout(timeout);
        controller.abort();
        await deleteClaudeSessionTranscript({
          sessionId,
          claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        });
        await rm(cwd, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
