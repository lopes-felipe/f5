import {
  query,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  createControllableAsyncIterable,
  FakeClaudeCodeProcess,
  respondToInitializeRequest,
} from "./ClaudeSdk.testUtils.ts";

async function* emptyPrompt(): AsyncGenerator<never, void, void> {}

describe("Claude SDK fast mode probe", () => {
  let activeQuery: ReturnType<typeof query> | null = null;

  afterEach(() => {
    activeQuery?.close();
    activeQuery = null;
  });

  it("passes fast mode through the SDK settings flag", async () => {
    let spawnOptions: SpawnOptions | undefined;

    activeQuery = query({
      prompt: emptyPrompt(),
      options: {
        persistSession: false,
        settings: {
          fastMode: true,
        },
        spawnClaudeCodeProcess: (options): SpawnedProcess => {
          spawnOptions = options;
          return new FakeClaudeCodeProcess((message, process) => {
            respondToInitializeRequest(message, process, {
              fast_mode_state: "on",
            });
          });
        },
      },
    });

    const initialization = await activeQuery.initializationResult();
    expect(initialization.fast_mode_state).toBe("on");

    expect(spawnOptions).toBeDefined();
    const settingsFlagIndex = spawnOptions?.args.indexOf("--settings") ?? -1;
    expect(settingsFlagIndex).toBeGreaterThan(-1);
    expect(JSON.parse(spawnOptions?.args[settingsFlagIndex + 1] ?? "")).toEqual({
      fastMode: true,
    });
  });

  it("does not emit unhandled rejections when prompt input completes while idle", async () => {
    const prompt = createControllableAsyncIterable<SDKUserMessage>();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    let firstPromptWrittenResolve: (() => void) | undefined;
    const firstPromptWritten = new Promise<void>((resolve) => {
      firstPromptWrittenResolve = resolve;
    });

    try {
      activeQuery = query({
        prompt: prompt.iterable,
        options: {
          persistSession: false,
          spawnClaudeCodeProcess: (): SpawnedProcess =>
            new FakeClaudeCodeProcess((message, process) => {
              if (respondToInitializeRequest(message, process)) {
                return;
              }

              if (message.type === "user") {
                firstPromptWrittenResolve?.();
                firstPromptWrittenResolve = undefined;
              }
            }),
        },
      });

      await activeQuery.initializationResult();

      prompt.push({
        type: "user",
        session_id: "",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        parent_tool_use_id: null,
      });

      await firstPromptWritten;
      prompt.end();
      activeQuery.close();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      prompt.end();
    }
  });
});
