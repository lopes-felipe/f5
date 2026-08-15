import "../../index.css";

import { ThreadId, type ServerProviderModel } from "@t3tools/contracts";
import { createClaudeModelCapabilities, createModelCapabilities } from "@t3tools/shared/model";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ClaudeTraitsPicker } from "./ClaudeTraitsPicker";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import { useModelPreferencesStore } from "../../modelPreferencesStore";
import { providerModelOptionsToSelections } from "../../providerModelOptions";

const CLAUDE_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-opus-5"),
  },
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          currentValue: "max",
          promptInjectedValues: ["ultrathink"],
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
        },
        {
          id: "contextWindow",
          label: "Context Window",
          type: "select",
          currentValue: "200k",
          options: [
            { id: "200k", label: "200k", isDefault: true },
            { id: "1m", label: "1M" },
          ],
        },
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          promptInjectedValues: ["ultrathink"],
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
            { id: "ultrathink", label: "Ultrathink" },
          ],
        },
        {
          id: "contextWindow",
          label: "Context Window",
          type: "select",
          currentValue: "200k",
          options: [
            { id: "200k", label: "200k", isDefault: true },
            { id: "1m", label: "1M" },
          ],
        },
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          promptInjectedValues: ["ultrathink"],
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "ultrathink", label: "Ultrathink" },
          ],
        },
        {
          id: "contextWindow",
          label: "Context Window",
          type: "select",
          currentValue: "200k",
          options: [
            { id: "200k", label: "200k", isDefault: true },
            { id: "1m", label: "1M" },
          ],
        },
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        {
          id: "thinking",
          label: "Thinking",
          type: "boolean",
          currentValue: true,
        },
      ],
    }),
  },
];

async function mountPicker(props?: {
  model?: string;
  prompt?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultrathink" | null;
  thinkingEnabled?: boolean | null;
  fastModeEnabled?: boolean;
  contextWindow?: "200k" | "1m";
}) {
  const threadId = ThreadId.makeUnsafe("thread-claude-traits");
  const model = props?.model ?? "claude-opus-4-6";
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  draftsByThreadId[threadId] = {
    prompt: props?.prompt ?? "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    filePaths: [],
    terminalContexts: [],
    provider: "claudeAgent",
    providerInstanceId: null,
    model,
    modelOptions: {
      claudeAgent: {
        ...(props?.effort ? { effort: props.effort } : {}),
        ...(props?.thinkingEnabled === false ? { thinking: false } : {}),
        ...(props?.fastModeEnabled ? { fastMode: true } : {}),
        ...(props?.contextWindow ? { contextWindow: props.contextWindow } : {}),
      },
    },
    runtimeMode: null,
    interactionMode: null,
    effort: null,
    codexFastMode: false,
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const PickerHarness = () => {
    const draft = useComposerThreadDraft(threadId);
    return (
      <ClaudeTraitsPicker
        threadId={threadId}
        model={model}
        models={CLAUDE_MODELS}
        modelOptions={providerModelOptionsToSelections("claudeAgent", draft.modelOptions)}
      />
    );
  };
  const screen = await render(<PickerHarness />, { container: host });

  return {
    threadId,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ClaudeTraitsPicker", () => {
  beforeEach(() => {
    localStorage.clear();
    useModelPreferencesStore.setState({
      lastProvider: null,
      lastModelByProvider: {},
      lastModelOptions: null,
      lastWorkflowProviderBySlot: {},
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
    });
  });

  it("shows Opus 5 reasoning and Fast Mode without context or thinking controls", async () => {
    const mounted = await mountPicker({ model: "claude-opus-5" });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("High");
        expect(document.querySelector('[aria-label="Fast mode enabled"]')).toBeNull();
      });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Reasoning");
        expect(text).toContain("Fast Mode");
        expect(text).toContain("Off");
        expect(text).toContain("On");
        expect(text).not.toContain("Context Window");
        expect(text).not.toContain("Thinking");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows fast mode as an icon only when enabled", async () => {
    const mounted = await mountPicker({ model: "claude-opus-5", fastModeEnabled: true });

    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[aria-label="Fast mode enabled"]')).not.toBeNull();
        expect(page.getByRole("button").element().textContent ?? "").not.toContain("Fast");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows effort controls for Claude Fable 5 without fast mode or thinking", async () => {
    const mounted = await mountPicker({ model: "claude-fable-5" });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Max · 200k");
      });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Reasoning");
        expect(text).toContain("Low");
        expect(text).toContain("Medium");
        expect(text).toContain("High");
        expect(text).toContain("Extra High");
        expect(text).toContain("Max");
        expect(text).toContain("Ultrathink");
        expect(text).toContain("Context Window");
        expect(text).toContain("200k (default)");
        expect(text).toContain("1M");
        expect(text).not.toContain("Fast Mode");
        expect(text).not.toContain("Thinking");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates Claude Fable 5 context-window draft options and trigger text", async () => {
    const mounted = await mountPicker({ model: "claude-fable-5" });

    try {
      await page.getByRole("button").click();
      await page.getByText("1M").click();

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().draftsByThreadId[mounted.threadId];
        expect(draft?.modelOptions).toEqual({
          claudeAgent: {
            effort: "max",
            contextWindow: "1m",
          },
        });
        expect(document.body.textContent ?? "").toContain("Max · 1M");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides fast mode controls for Claude Sonnet 4.6", async () => {
    const mounted = await mountPicker({ model: "claude-sonnet-4-6" });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Fast Mode");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows only the provided effort options", async () => {
    const mounted = await mountPicker({
      model: "claude-sonnet-4-6",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Low");
        expect(text).toContain("Medium");
        expect(text).toContain("High");
        expect(text).not.toContain("Extra High");
        expect(text).not.toContain("Max");
        expect(text).toContain("Ultrathink");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a thinking on/off dropdown for Haiku", async () => {
    const mounted = await mountPicker({
      model: "claude-haiku-4-5",
      thinkingEnabled: true,
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Thinking On");
      });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Thinking");
        expect(text).toContain("On");
        expect(text).toContain("Off");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps prompt text independent from the selected effort", async () => {
    const mounted = await mountPicker({
      effort: "high",
      model: "claude-opus-4-6",
      prompt: "Ultrathink:\nInvestigate this",
      fastModeEnabled: false,
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("High · 200k");
      });
      await page.getByRole("button").click();
      await page.getByText("Medium").click();

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().draftsByThreadId[mounted.threadId];
        expect(draft?.prompt).toBe("Ultrathink:\nInvestigate this");
        expect(draft?.modelOptions?.claudeAgent?.effort).toBe("medium");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("stores Ultrathink as an explicit effort without changing the prompt", async () => {
    const mounted = await mountPicker({
      effort: "high",
      model: "claude-opus-4-6",
      prompt: "Investigate this",
    });

    try {
      await page.getByRole("button").click();
      await page.getByText("Ultrathink").click();

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().draftsByThreadId[mounted.threadId];
        expect(draft?.prompt).toBe("Investigate this");
        expect(draft?.modelOptions?.claudeAgent?.effort).toBe("ultrathink");
        expect(document.body.textContent ?? "").toContain("Ultrathink · 200k");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
