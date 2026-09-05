import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  query,
  type Query,
  type SDKUserMessage,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable.ts";
import { createControllableAsyncIterable } from "../src/provider/Layers/ClaudeSdk.testUtils.ts";
import { normalizeClaudeAccountUsage } from "../src/usage/claudeAccountUsage.ts";
import { makeClaudeTextGeneration } from "../src/git/Layers/ClaudeTextGeneration.ts";

// Explicit opt-in: uses the current Claude account and consumes its quota.
// Auth/quota/entitlement failures fail the run; they are never converted to skips.
describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")(
  "bundled Claude release prerequisites",
  () => {
    async function withQuery(
      use: (
        q: Query,
        input: ReturnType<typeof createControllableAsyncIterable<SDKUserMessage>>,
      ) => Promise<void>,
    ) {
      const cwd = mkdtempSync(join(tmpdir(), "f5-claude-live-"));
      const input = createControllableAsyncIterable<SDKUserMessage>();
      const abort = new AbortController();
      const children: ChildProcess[] = [];
      const closed = new Set<ChildProcess>();
      const q = query({
        prompt: input.iterable,
        options: {
          cwd,
          model: "claude-fable-5-1",
          persistSession: false,
          settingSources: [],
          env: buildClaudeQueryEnv({ subagentModel: "inherit" }),
          abortController: abort,
          includePartialMessages: true,
          maxTurns: 10,
          canUseTool: async (name, toolInput) =>
            name === "TodoWrite"
              ? { behavior: "allow", updatedInput: toolInput }
              : { behavior: "deny", message: "This smoke test only permits TodoWrite." },
          spawnClaudeCodeProcess: (options) => {
            expect(options.command).toBe(resolveBundledClaudeExecutable());
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
            children.push(child);
            child.once("close", () => closed.add(child));
            return child;
          },
        },
      });
      const deadline = setTimeout(() => {
        abort.abort();
        q.close();
      }, 50_000);
      try {
        await use(q, input);
      } finally {
        abort.abort();
        q.close();
        input.end();
        clearTimeout(deadline);
        try {
          await expect.poll(() => closed.size, { timeout: 5_000 }).toBe(children.length);
        } finally {
          rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    }

    it("parses real account usage and native context, then cancels and reaps the idle executable", async () => {
      await withQuery(async (q) => {
        await q.initializationResult();
        const usage = normalizeClaudeAccountUsage(
          await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
            skipBehaviors: true,
          }),
        );
        expect(typeof usage.limitsAvailable).toBe("boolean");
        const context = await q.getContextUsage({ detail: "summary" });
        expect(context.model).toBe("claude-fable-5-1");
        expect(context.maxTokens).toBe(1_000_000);
      });
    }, 60_000);

    it("advertises and successfully uses TodoWrite to complete three steps in a streamed turn", async () => {
      await withQuery(async (q, input) => {
        await q.initializationResult();
        input.push({
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content:
              "Use TodoWrite to track exactly three steps: compute 2+2, compute 3+3, and report both answers. Keep one in_progress at a time and mark all three completed using TodoWrite. Do not use other tools.",
          },
        });
        const messages: SDKMessage[] = [];
        for (;;) {
          const next = await q.next();
          expect(next.done, "Executable exited without a result").toBe(false);
          if (next.done) break;
          messages.push(next.value);
          if (next.value.type === "result") {
            expect(next.value.is_error, JSON.stringify(next.value)).toBe(false);
            expect(next.value.subtype).toBe("success");
            break;
          }
        }
        expect(
          messages.some(
            (m) => m.type === "system" && m.subtype === "init" && m.tools.includes("TodoWrite"),
          ),
        ).toBe(true);
        expect(messages.some((m) => m.type === "stream_event")).toBe(true);
        const calls = messages.flatMap((m) =>
          m.type === "assistant"
            ? m.message.content.filter(
                (block) => block.type === "tool_use" && block.name === "TodoWrite",
              )
            : [],
        );
        expect(calls.length).toBeGreaterThanOrEqual(2);
        const last = calls.at(-1);
        expect(last?.type).toBe("tool_use");
        if (last?.type === "tool_use") {
          const input = last.input as { todos: Array<{ status: string }> };
          expect(input.todos).toHaveLength(3);
          expect(input.todos.every((todo) => todo.status === "completed")).toBe(true);
          expect(
            messages.some(
              (m) =>
                m.type === "user" &&
                Array.isArray(m.message.content) &&
                m.message.content.some(
                  (block) =>
                    block.type === "tool_result" &&
                    block.tool_use_id === last.id &&
                    !block.is_error,
                ),
            ),
          ).toBe(true);
        }
      });
    }, 60_000);

    it("validates real --json-schema output with --effort xhigh through production generation", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "f5-claude-json-live-"));
      try {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const generation = yield* makeClaudeTextGeneration(
              Schema.decodeSync(ClaudeSettings)({}),
            );
            return yield* generation.generateStructuredJson({
              cwd,
              operation: "release-smoke",
              prompt: "Return the required JSON object with ok true. Do not use tools.",
              outputSchema: Schema.Struct({ ok: Schema.Literal(true) }),
              modelSelection: {
                instanceId: ProviderInstanceId.make("claudeAgent"),
                model: "claude-fable-5-1",
                options: [{ id: "effort", value: "xhigh" }],
              },
            });
          }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("50 seconds")),
        );
        expect(result).toEqual({ ok: true });
      } finally {
        // Windows can briefly retain filesystem handles after the CLI exits.
        rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }, 60_000);
  },
);
