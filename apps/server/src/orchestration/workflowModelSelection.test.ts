import {
  CommandId,
  defaultInstanceIdForDriver,
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveAvailableWorkflowModelSlot,
  resolveAvailableWorkflowTurnCommand,
  workflowTurnProviderFields,
} from "./workflowModelSelection";

function claudeProvider(models: ReadonlyArray<string>): ServerProvider {
  const driver = ProviderDriverKind.make("claudeAgent");
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    driver,
    enabled: true,
    installed: true,
    version: "2.1.219",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-28T00:00:00.000Z",
    models: models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

describe("resolveAvailableWorkflowModelSlot", () => {
  it("revalidates persisted Fable aliases against the dispatch instance", () => {
    const slot = {
      provider: "claudeAgent",
      model: "fable",
      providerOptions: { claudeAgent: { subagentModel: "fable-5-1" } },
    } as const;
    expect(
      resolveAvailableWorkflowModelSlot(slot, [
        claudeProvider(["claude-opus-5", "claude-fable-5-1"]),
      ]),
    ).toEqual({ ...slot, model: "claude-fable-5-1" });
    expect(
      resolveAvailableWorkflowModelSlot(slot, [
        claudeProvider(["claude-opus-5", "claude-fable-5"]),
      ]),
    ).toEqual({ ...slot, model: "claude-opus-5" });
  });
  it("falls back before dispatch when Opus 5 is absent from a known-version snapshot", () => {
    expect(
      resolveAvailableWorkflowModelSlot(
        {
          provider: "claudeAgent",
          model: "opus-5[1m]",
          modelOptions: { claudeAgent: { effort: "high", fastMode: true } },
          providerOptions: { claudeAgent: { binaryPath: "/tmp/claude" } },
        },
        [claudeProvider(["claude-fable-5", "claude-opus-4-8"])],
      ),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-fable-5",
      providerOptions: { claudeAgent: { binaryPath: "/tmp/claude" } },
    });
  });

  it("canonicalizes Opus 5 and preserves its options once the live snapshot exposes it", () => {
    expect(
      resolveAvailableWorkflowModelSlot(
        {
          provider: "claudeAgent",
          model: "opus-5[1m]",
          modelOptions: { claudeAgent: { effort: "high", fastMode: true } },
          providerOptions: { claudeAgent: { subagentsEnabled: false } },
        },
        [claudeProvider(["claude-opus-5", "claude-fable-5"])],
      ),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-5",
      modelOptions: { claudeAgent: { effort: "high", fastMode: true } },
      providerOptions: { claudeAgent: { subagentsEnabled: false } },
    });
  });

  it("revalidates persisted model slots on deferred turn dispatch", () => {
    const command = {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("command-1"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      message: {
        messageId: MessageId.makeUnsafe("message-1"),
        role: "user",
        text: "continue",
        attachments: [],
      },
      provider: "claudeAgent",
      model: "claude-opus-5",
      modelOptions: { claudeAgent: { effort: "high", fastMode: true } },
      providerOptions: { claudeAgent: { permissionMode: "plan" } },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-07-28T00:00:00.000Z",
    } as const;
    const { modelOptions: _discardedModelOptions, ...commandWithoutOptions } = command;

    expect(
      resolveAvailableWorkflowTurnCommand(command, [
        claudeProvider(["claude-fable-5", "claude-opus-4-8"]),
      ]),
    ).toEqual({
      ...commandWithoutOptions,
      model: "claude-fable-5",
    });
  });

  it("builds the complete provider fields for workflow turns", () => {
    expect(
      workflowTurnProviderFields({
        provider: "claudeAgent",
        model: "claude-opus-5",
        modelOptions: { claudeAgent: { effort: "max" } },
        providerOptions: { claudeAgent: { subagentsEnabled: false } },
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-5",
      modelOptions: { claudeAgent: { effort: "max" } },
      providerOptions: { claudeAgent: { subagentsEnabled: false } },
    });
  });
});
