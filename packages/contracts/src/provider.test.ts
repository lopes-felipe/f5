import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      projectTitle: "Workspace Project",
      threadTitle: "Feature thread",
      turnCount: 3,
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        codex: {
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.projectTitle).toBe("Workspace Project");
    expect(parsed.threadTitle).toBe("Feature thread");
    expect(parsed.turnCount).toBe(3);
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("high");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("accepts compaction restoration context for resumed Claude sessions", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      runtimeMode: "full-access",
      priorWorkSummary: "Summary:\n1. Implemented the task list UI",
      preservedTranscriptAfter: "[2026-04-03] USER\nPlease finish phase 4.",
      restoredRecentFileRefs: ["apps/server/src/orchestration/decider.ts"],
      restoredActivePlan: "1. Add compaction worker\n2. Wire Claude session restore",
      restoredTasks: ["[in_progress] Wiring compaction"],
    });

    expect(parsed.priorWorkSummary).toContain("Implemented the task list UI");
    expect(parsed.preservedTranscriptAfter).toContain("Please finish phase 4.");
    expect(parsed.restoredRecentFileRefs).toEqual(["apps/server/src/orchestration/decider.ts"]);
    expect(parsed.restoredTasks).toEqual(["[in_progress] Wiring compaction"]);
  });

  it("accepts Claude provider start options for subagent settings", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      runtimeMode: "full-access",
      providerOptions: {
        claudeAgent: {
          subagentsEnabled: false,
          subagentModel: "inherit",
        },
      },
    });

    expect(parsed.providerOptions?.claudeAgent?.subagentsEnabled).toBe(false);
    expect(parsed.providerOptions?.claudeAgent?.subagentModel).toBe("inherit");
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts provider-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
  });
});
