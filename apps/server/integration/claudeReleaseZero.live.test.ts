import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  query,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildClaudeQueryEnv } from "../src/provider/Layers/ClaudeAdapter.ts";
import { claudeMandatoryPolicyOptions } from "../src/provider/claudeMandatoryPolicy.ts";

async function run(promptText: string, options: Options): Promise<SDKMessage[]> {
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      uuid: randomUUID(),
      origin: { kind: "human" },
      message: { role: "user", content: promptText },
    };
  }
  const controller = new AbortController();
  const runtime = query({
    prompt: prompt(),
    options: {
      model: "claude-fable-5-1",
      settingSources: [],
      permissionMode: "default",
      maxTurns: 4,
      env: buildClaudeQueryEnv(undefined, process.env),
      ...options,
      abortController: controller,
    },
  });
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const messages: SDKMessage[] = [];
    for await (const message of runtime) {
      messages.push(message);
      if (message.type === "result") break;
    }
    const result = messages.find((message) => message.type === "result");
    expect(result, "Claude must return a result").toBeDefined();
    if (result?.type === "result") expect(result.is_error, JSON.stringify(result)).toBe(false);
    return messages;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    runtime.close();
  }
}
const text = (messages: SDKMessage[]) =>
  messages
    .flatMap((message) =>
      message.type === "assistant"
        ? message.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        : [],
    )
    .join("\n");

describe.skipIf(process.env.F5_CLAUDE_LIVE_TEST !== "1")("Release 0 Claude certification", () => {
  it("replaces a pre-existing prompt snapshot with a fresh sentinel append on two resumes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "f5-r0-snapshot-"));
    const sessionId = randomUUID();
    const sentinel = `F5_${randomUUID().replaceAll("-", "")}`;
    try {
      await run("Reply with READY.", { cwd, sessionId, tools: [] });
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages = await run("What is the host sentinel? Reply with its exact value only.", {
          cwd,
          resume: sessionId,
          tools: [],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            snapshot: false,
            append: `The host sentinel is ${sentinel}. If asked for the host sentinel, reply with that value.`,
          },
        });
        expect(text(messages)).toContain(sentinel);
      }
      console.log("R0.1 snapshot:false sentinel confirmed on two resumes");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  it("blocks a project-allowed shell in full access before canUseTool", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "f5-r0-policy-"));
    await mkdir(join(cwd, ".claude"));
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
    );
    let attempts = 0;
    const policy = claudeMandatoryPolicyOptions({
      workflowExecutionProfile: "unattended-readonly",
    });
    const hostHook = policy.hooks!.PreToolUse![0]!.hooks[0]!;
    policy.hooks!.PreToolUse![0]!.hooks[0] = async (...args) => {
      if (args[0].hook_event_name === "PreToolUse" && args[0].tool_name === "Bash") attempts++;
      return hostHook(...args);
    };
    try {
      await run(
        "Call Bash with command `printf F5_POLICY_PROBE` exactly once. If denied, stop and report the denial.",
        {
          cwd,
          persistSession: false,
          settingSources: ["project"],
          tools: ["Bash"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          ...policy,
          canUseTool: async () => {
            throw new Error("Native allow rule should be stopped by PreToolUse before canUseTool");
          },
        },
      );
      expect(attempts).toBeGreaterThan(0);
      console.log("R0.2 project allow + full access denied by host PreToolUse");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 65_000);
});
