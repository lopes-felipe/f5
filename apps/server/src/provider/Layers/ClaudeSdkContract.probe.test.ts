import { query, type Options, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { FakeClaudeCodeProcess, respondToInitializeRequest } from "./ClaudeSdk.testUtils.ts";

async function* emptyPrompt(): AsyncGenerator<never> {}

describe("Claude SDK host contract transport", () => {
  it.each([undefined, "550e8400-e29b-41d4-a716-446655440000"])(
    "serializes host instructions and mandatory flags (resume=%s)",
    async (resume) => {
      let initialize: Record<string, unknown> | undefined;
      let spawn: SpawnOptions | undefined;
      const options = {
        ...(resume ? { resume } : {}),
        persistSession: false,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "F5 sentinel",
          snapshot: false,
        },
        planModeInstructions: "F5 plan sentinel",
        permissionMode: "default",
        effort: "xhigh",
        thinking: { type: "disabled" },
        disallowedTools: ["Agent", "Task"],
        spawnClaudeCodeProcess: (args) => {
          spawn = args;
          return new FakeClaudeCodeProcess((message, child) => {
            if (respondToInitializeRequest(message, child)) {
              initialize = message.request as Record<string, unknown>;
            }
          });
        },
      } satisfies Options;
      const runtime = query({ prompt: emptyPrompt(), options });
      try {
        await runtime.initializationResult();
        expect(initialize).toMatchObject({
          appendSystemPrompt: "F5 sentinel",
          systemPromptSnapshot: false,
          planModeInstructions: "F5 plan sentinel",
        });
        const args = spawn!.args;
        for (const [flag, value] of [
          ["--permission-mode", "default"],
          ["--effort", "xhigh"],
          ["--disallowedTools", "Agent,Task"],
        ] as const) {
          expect(args[args.indexOf(flag) + 1], flag).toBe(value);
        }
        expect(args).toContain("--thinking");
        expect(args[args.indexOf("--thinking") + 1]).toBe("disabled");
      } finally {
        runtime.close();
      }
    },
  );
});
