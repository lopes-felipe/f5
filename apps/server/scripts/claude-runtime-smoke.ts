import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeClaudeProcessGroupSpawner } from "../src/provider/claudeProcessGroup.ts";
import { appendClaudeStderrTail } from "../src/provider/claudeProcessExit.ts";
import {
  resolveClaudeCliInvocation,
  resolveClaudeSdkExecutableOptions,
} from "../src/provider/claudeSdkExecutable.ts";

// Run this entry through the packaged Electron binary with ELECTRON_RUN_AS_NODE=1.
// No prompt or real account is used: only CLI discovery and SDK initialization.
async function smokeClaudeRuntime(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "f5-claude-runtime-smoke-"));
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: root,
    TMP: root,
    TMPDIR: root,
    HOME: root,
    USERPROFILE: root,
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
  };
  let endInput = () => {};
  const inputEnded = new Promise<void>((resolve) => {
    endInput = resolve;
  });
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          await inputEnded;
          return { done: true, value: undefined };
        },
      };
    },
  };
  let stderr = "";
  const recordStderr = (data: string) => {
    stderr = appendClaudeStderrTail(stderr, data);
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let session: ReturnType<typeof query> | undefined;
  try {
    const invocation = resolveClaudeCliInvocation("claude", ["--version"], environment);
    const sdkOptions = resolveClaudeSdkExecutableOptions("claude", environment);
    if (invocation.file !== sdkOptions.pathToClaudeCodeExecutable) {
      throw new Error("Claude CLI discovery and SDK launch resolved different executables.");
    }
    const version = execFileSync(invocation.file, [...invocation.args], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error("Claude --version did not report a CLI version.");
    }
    const spawnClaudeCodeProcess = makeClaudeProcessGroupSpawner(recordStderr);
    session = query({
      prompt,
      options: {
        ...sdkOptions,
        ...(spawnClaudeCodeProcess ? { spawnClaudeCodeProcess } : {}),
        abortController: controller,
        cwd: root,
        env: environment,
        settingSources: [],
        persistSession: false,
        strictMcpConfig: true,
        tools: [],
        extraArgs: { "no-chrome": null },
        stderr: recordStderr,
      },
    });
    await session.initializationResult();
    console.log(JSON.stringify({ version, sdkInitialized: true, providerTurnsStarted: 0 }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (stderr) console.error(stderr);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    endInput();
    session?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

void smokeClaudeRuntime().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
