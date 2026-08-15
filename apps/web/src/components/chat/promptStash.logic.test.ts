import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { PromptStashDraftSelection, PromptStashEntry } from "~/composerDraftStore";

import { resolvePromptStashSelection } from "./promptStash.logic";

const fallback: PromptStashDraftSelection = {
  provider: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
  modelOptions: null,
  runtimeMode: "full-access",
  interactionMode: "default",
  effort: null,
  codexFastMode: false,
};

function provider(input: {
  instanceId: string;
  driver: "codex" | "cursor";
  models: string[];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-15T00:00:00.000Z",
    models: input.models.map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

function stash(selection: Partial<PromptStashDraftSelection>): PromptStashEntry {
  return {
    version: 1,
    id: "stash-1",
    sourceThreadId: ThreadId.make("thread-1"),
    sourceProjectId: ProjectId.make("project-1"),
    sourceWorkspaceRoot: "/repo",
    createdAt: "2026-08-15T00:00:00.000Z",
    preview: "saved",
    draft: {
      ...fallback,
      prompt: "saved",
      attachments: [],
      filePaths: [],
      terminalContexts: [],
      ...selection,
    },
  };
}

describe("resolvePromptStashSelection", () => {
  it("retains an available provider, model, and runtime mode", () => {
    const result = resolvePromptStashSelection({
      stash: stash({ model: "gpt-5.1", runtimeMode: "auto" }),
      providers: [provider({ instanceId: "codex", driver: "codex", models: ["gpt-5.1"] })],
      modelSlugsByInstance: new Map(),
      fallback,
    });
    expect(result.selection.model).toBe("gpt-5.1");
    expect(result.selection.runtimeMode).toBe("auto");
    expect(result.warnings).toEqual([]);
  });

  it("falls back visibly when a saved provider or mode is unavailable", () => {
    const result = resolvePromptStashSelection({
      stash: stash({
        provider: "cursor",
        providerInstanceId: ProviderInstanceId.make("missing-cursor"),
        model: "composer-2",
        runtimeMode: "auto",
      }),
      providers: [provider({ instanceId: "cursor", driver: "cursor", models: ["composer-1"] })],
      modelSlugsByInstance: new Map(),
      fallback,
    });
    expect(result.selection.provider).toBe("cursor");
    expect(result.selection.model).toBe("composer-1");
    expect(result.selection.runtimeMode).toBe("full-access");
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });
});
