import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import { ServerConfig } from "../../config.ts";
import { writeCliScript } from "../../testUtils/cli.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";

// A real child process speaking the SDK protocol, not a real historical Claude
// binary. Rejects the model by exiting, so transport/adapter failure is exercised.
const executableSource = `
const { createInterface } = require("node:readline");
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
let model = process.argv[process.argv.indexOf("--model") + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    if (m.request.subtype === "set_model") model = m.request.model;
    emit({ type: "control_response", response: { subtype: "success", request_id: m.request_id,
      response: m.request.subtype === "initialize" ? {
        commands: [], agents: [], models: [], output_style: "default", available_output_styles: ["default"]
      } : {} } });
  } else if (m.type === "user") {
    const subagent = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    appendFileSync(join(process.cwd(), "invocations.jsonl"), JSON.stringify({ model, subagent, pid: process.pid }) + "\\n");
    if (model === "claude-fable-5-1" || subagent === "claude-fable-5-1") {
      process.stderr.write("Unsupported model claude-fable-5-1\\n", () => process.exit(1));
      return;
    }
    emit({ type: "assistant", uuid: "answer", session_id: "fixture-session", parent_tool_use_id: null,
      message: { id: "answer", role: "assistant", model, content: [{ type: "text", text: "Retry succeeded" }],
        usage: { input_tokens: 1, output_tokens: 2 } } });
    emit({ type: "result", subtype: "success", is_error: false, result: "Retry succeeded",
      uuid: "result", session_id: "fixture-session", duration_ms: 1, duration_api_ms: 1,
      num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: {}, permission_denials: [] });
  }
});
`;

it.each(["parent", "subagent"] as const)(
  "terminates executable rejection and completes a retry after correcting the %s model",
  async (scenario) => {
    const cwd = mkdtempSync(join(tmpdir(), "f5-claude-recovery-"));
    const binaryPath = join(cwd, "old-claude.js");
    renameSync(writeCliScript(join(cwd, "old-claude"), executableSource), binaryPath);
    const layer = makeClaudeAdapterLive({
      createQuery: (input) =>
        query({
          prompt: input.prompt,
          options: { ...input.options, persistSession: false } as Options,
        }),
      probeResumableClaudeSession: () => Effect.succeed("unknown" as const),
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(cwd, cwd)),
      Layer.provideMerge(NodeServices.layer),
    );
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const threadId = ThreadId.makeUnsafe("recovery-thread");
          yield* adapter.startSession({
            threadId,
            provider: "claudeAgent",
            cwd,
            runtimeMode: "full-access",
            model: scenario === "parent" ? "fable" : "fable-5",
            providerOptions: {
              claudeAgent: {
                binaryPath,
                subagentModel: scenario === "subagent" ? "fable" : "inherit",
              },
            },
          });
          yield* adapter.sendTurn({ threadId, input: "first attempt", attachments: [] });
          const failureEvents = yield* Stream.takeUntil(
            adapter.streamEvents,
            (event) => event.type === "session.exited",
          ).pipe(Stream.runCollect);
          const failure = failureEvents.find((event) => event.type === "turn.completed");
          expect(failure?.payload.state).toBe("failed");
          expect(failure?.payload.errorMessage).toMatch(/code 1|unsupported/i);
          expect(failureEvents.at(-1)?.type).toBe("session.exited");
          yield* adapter.startSession({
            threadId,
            provider: "claudeAgent",
            cwd,
            runtimeMode: "full-access",
            model: "fable-5",
            providerOptions: {
              claudeAgent: {
                binaryPath,
                subagentModel: scenario === "parent" ? "inherit" : "fable-5",
              },
            },
          });
          yield* adapter.sendTurn({ threadId, input: "retry", attachments: [] });
          const retryEvents = yield* Stream.takeUntil(
            adapter.streamEvents,
            (event) => event.type === "turn.completed",
          ).pipe(Stream.runCollect);
          const success = retryEvents.find(
            (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
              event.type === "turn.completed",
          );
          expect(success?.payload.state).toBe("completed");
          expect(success?.payload.errorMessage).toBeUndefined();
          expect(retryEvents.some((event) => event.type === "content.delta")).toBe(true);
          yield* adapter.stopSession(threadId);
        }).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout("10 seconds")),
      );
      const invocations = readFileSync(join(cwd, "invocations.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { model: string; subagent?: string; pid: number });
      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.[scenario === "parent" ? "model" : "subagent"]).toBe(
        "claude-fable-5-1",
      );
      expect(invocations[1]?.model).toBe("claude-fable-5");
      expect(invocations[1]?.subagent).toBe(scenario === "parent" ? undefined : "claude-fable-5");
      for (const invocation of invocations)
        await expect
          .poll(() => {
            try {
              process.kill(invocation.pid, 0);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);
