import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
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
import {
  isTaskToolName,
  reduceTaskToolLifecycle,
  type TaskToolState,
} from "@t3tools/shared/claudeTaskToolProjection";
import { getDefaultReasoningEffort } from "@t3tools/shared/model";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import { resolveBundledClaudeExecutable } from "../src/provider/claudeSdkExecutable.ts";
import { createControllableAsyncIterable } from "../src/provider/Layers/ClaudeSdk.testUtils.ts";
import { normalizeClaudeAccountUsage } from "../src/usage/claudeAccountUsage.ts";
import { makeClaudeTextGeneration } from "../src/git/Layers/ClaudeTextGeneration.ts";
import { buildClaudeToolCompletion } from "../src/provider/claudeToolCompletion.ts";

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
      model = "claude-fable-5-1",
      environment: NodeJS.ProcessEnv = process.env,
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
          model,
          // Preserve the older smoke leg's CLI defaults; exercise F5's Opus 5.5 default.
          ...(model === "claude-opus-5-5"
            ? { effort: getDefaultReasoningEffort("claudeAgent", model) }
            : {}),
          persistSession: false,
          settingSources: [],
          env: buildClaudeQueryEnv({ subagentModel: "inherit" }, environment),
          abortController: abort,
          includePartialMessages: true,
          maxTurns: 10,
          canUseTool: async (name, toolInput) =>
            name === "TodoWrite" || isTaskToolName(name)
              ? { behavior: "allow", updatedInput: toolInput }
              : { behavior: "deny", message: "This smoke test only permits task tools." },
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
      }, 80_000);
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
          await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    }

    it.each(["claude-fable-5-1", "claude-opus-5-5"])(
      "parses %s account usage and native context, then cancels and reaps the idle executable",
      async (model) => {
        await withQuery(async (q) => {
          await q.initializationResult();
          const usage = normalizeClaudeAccountUsage(
            await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
              skipBehaviors: true,
            }),
          );
          expect(typeof usage.limitsAvailable).toBe("boolean");
          const context = await q.getContextUsage({ detail: "summary" });
          expect(context.model).toBe(model);
          if (model === "claude-opus-5-5")
            expect(getDefaultReasoningEffort("claudeAgent", model)).toBe("medium");
          expect(context.maxTokens).toBe(1_000_000);
        }, model);
      },
      60_000,
    );

    // This suite may itself run inside a Claude Code session whose task variables
    // would be honored as operator overrides; start from production defaults.
    const {
      CLAUDE_CODE_ENABLE_TASKS: _tasks,
      CLAUDE_CODE_ENABLE_TODO_TOOLS: _todos,
      ...defaultEnv
    } = process.env;

    async function runTurn(
      q: Query,
      input: ReturnType<typeof createControllableAsyncIterable<SDKUserMessage>>,
      prompt: string,
    ) {
      await q.initializationResult();
      input.push({
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: prompt },
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
      expect(messages.some((m) => m.type === "stream_event")).toBe(true);
      return messages;
    }

    it("advertises native Task tools by default and projects a three-step task list", async () => {
      await withQuery(
        async (q, input) => {
          const messages = await runTurn(
            q,
            input,
            "Use TaskCreate to create exactly three tasks: compute 2+2, compute 3+3, and report both answers. Then use TaskUpdate to mark each one in_progress and then completed as you do it. Do not use any other tools.",
          );
          const init = messages.find((m) => m.type === "system" && m.subtype === "init");
          expect(init?.type === "system" && init.subtype === "init" ? init.tools : []).toEqual(
            expect.arrayContaining(["TaskCreate", "TaskUpdate"]),
          );
          expect(
            init?.type === "system" && init.subtype === "init" ? init.tools : [],
          ).not.toContain("TodoWrite");

          // Replay the real stream through F5's completion builder and shared reducer.
          const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
          let state: TaskToolState = { tasks: [], tracking: null };
          for (const message of messages) {
            if (message.type === "assistant" && !message.parent_tool_use_id) {
              for (const block of message.message.content) {
                if (block.type !== "tool_use" || !isTaskToolName(block.name) || calls.has(block.id))
                  continue;
                calls.set(block.id, {
                  name: block.name,
                  input: block.input as Record<string, unknown>,
                });
                state =
                  reduceTaskToolLifecycle(state, {
                    phase: "started",
                    nativeCallId: block.id,
                    toolName: block.name,
                    turnId: null,
                  }) ?? state;
              }
            }
            if (message.type !== "user" || message.parent_tool_use_id) continue;
            const content = Array.isArray(message.message.content) ? message.message.content : [];
            const results = content.filter((block) => block.type === "tool_result");
            for (const block of results) {
              if (block.type !== "tool_result") continue;
              const call = calls.get(block.tool_use_id);
              if (!call || !isTaskToolName(call.name)) continue;
              const { envelope } = buildClaudeToolCompletion({
                toolUseId: block.tool_use_id,
                toolName: call.name,
                toolInput: call.input,
                structuredOutput: (message as { tool_use_result?: unknown }).tool_use_result,
                correlated: results.length === 1,
                isError: block.is_error === true,
                nativeSessionId: message.session_id,
              });
              expect(envelope.semanticSuccess, JSON.stringify(envelope)).toBe(true);
              state =
                reduceTaskToolLifecycle(state, {
                  phase: "completed",
                  nativeCallId: block.tool_use_id,
                  toolName: call.name,
                  turnId: null,
                  completion: envelope,
                }) ?? state;
            }
          }
          expect([...calls.values()].filter((call) => call.name === "TaskCreate")).toHaveLength(3);
          expect(state.tracking?.syncState, JSON.stringify(state.tracking)).toBe("synced");
          expect(state.tracking?.pendingCalls).toEqual([]);
          expect(state.tasks).toHaveLength(3);
          expect(state.tasks.every((task) => task.status === "completed")).toBe(true);
        },
        "claude-fable-5-1",
        defaultEnv,
      );
    }, 90_000);

    it("keeps TodoWrite when an operator opts out of native Task tools", async () => {
      await withQuery(
        async (q, input) => {
          const messages = await runTurn(
            q,
            input,
            "Use TodoWrite to track exactly three steps: compute 2+2, compute 3+3, and report both answers. Mark all three completed using TodoWrite. Do not use other tools.",
          );
          expect(
            messages.some(
              (m) => m.type === "system" && m.subtype === "init" && m.tools.includes("TodoWrite"),
            ),
          ).toBe(true);
          const calls = messages.flatMap((m) =>
            m.type === "assistant"
              ? m.message.content.filter(
                  (block) => block.type === "tool_use" && block.name === "TodoWrite",
                )
              : [],
          );
          expect(calls.length).toBeGreaterThanOrEqual(1);
          const last = calls.at(-1);
          expect(last?.type).toBe("tool_use");
          if (last?.type === "tool_use") {
            const todos = (last.input as { todos: Array<{ status: string }> }).todos;
            expect(todos).toHaveLength(3);
            expect(todos.every((todo) => todo.status === "completed")).toBe(true);
          }
        },
        "claude-fable-5-1",
        { ...defaultEnv, CLAUDE_CODE_ENABLE_TASKS: "0" },
      );
    }, 60_000);

    it.each(["claude-fable-5-1", "claude-opus-4-8", "claude-opus-5-5"])(
      "validates %s --json-schema output with --effort xhigh through production generation",
      async (model) => {
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
                  model,
                  options: [{ id: "effort", value: "xhigh" }],
                },
              });
            }).pipe(Effect.provide(NodeServices.layer), Effect.timeout("50 seconds")),
          );
          expect(result).toEqual({ ok: true });
        } finally {
          // Windows can briefly retain filesystem handles after the CLI exits.
          await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      },
      60_000,
    );
  },
);
