import "../../index.css";

import { ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ClaudeTraitsPicker } from "./ClaudeTraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useModelPreferencesStore } from "../../modelPreferencesStore";

async function mountPicker(props?: {
  model?: string;
  prompt?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultrathink" | null;
  thinkingEnabled?: boolean | null;
  fastModeEnabled?: boolean;
}) {
  const threadId = ThreadId.makeUnsafe("thread-claude-traits");
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
    model: props?.model ?? "claude-opus-4-6",
    modelOptions: {
      claudeAgent: {
        ...(props?.effort ? { effort: props.effort } : {}),
        ...(props?.thinkingEnabled === false ? { thinking: false } : {}),
        ...(props?.fastModeEnabled ? { fastMode: true } : {}),
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
  const onPromptChange = vi.fn();
  const screen = await render(
    <ClaudeTraitsPicker
      threadId={threadId}
      model={props?.model ?? "claude-opus-4-6"}
      onPromptChange={onPromptChange}
    />,
    { container: host },
  );

  return {
    onPromptChange,
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

  it("shows fast mode controls for Claude Opus 4.6", async () => {
    const mounted = await mountPicker({ model: "claude-opus-4-6" });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Fast Mode");
        expect(text).toContain("off");
        expect(text).toContain("on");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows effort controls for Claude Opus 4.7 without fast mode", async () => {
    const mounted = await mountPicker({ model: "claude-opus-4-7" });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Extra High");
      });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Low");
        expect(text).toContain("Medium");
        expect(text).toContain("High");
        expect(text).toContain("Extra High");
        expect(text).toContain("Max");
        expect(text).toContain("Ultrathink");
        expect(text).not.toContain("Fast Mode");
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
        expect(text).toContain("On (default)");
        expect(text).toContain("Off");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows prompt-controlled Ultrathink state with disabled effort controls", async () => {
    const mounted = await mountPicker({
      effort: "high",
      model: "claude-opus-4-6",
      prompt: "Ultrathink:\nInvestigate this",
      fastModeEnabled: false,
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Ultrathink");
        expect(document.body.textContent ?? "").not.toContain("Ultrathink · Prompt");
      });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Effort");
        expect(text).toContain("Remove Ultrathink from the prompt to change effort.");
        expect(text).not.toContain("Fallback Effort");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
