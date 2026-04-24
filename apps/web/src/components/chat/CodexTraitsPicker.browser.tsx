import "../../index.css";

import { ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CodexTraitsPicker } from "./CodexTraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useModelPreferencesStore } from "../../modelPreferencesStore";

async function mountPicker(props?: {
  effort?: "low" | "medium" | "high" | "xhigh";
  fastModeEnabled?: boolean;
}) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  draftsByThreadId[threadId] = {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    filePaths: [],
    terminalContexts: [],
    provider: "codex",
    model: "gpt-5",
    modelOptions: {
      codex: {
        ...(props?.effort ? { reasoningEffort: props.effort } : {}),
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
  const screen = await render(<CodexTraitsPicker threadId={threadId} />, { container: host });

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("CodexTraitsPicker", () => {
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

  it("closes the menu after selecting a reasoning level", async () => {
    const mounted = await mountPicker({ effort: "high" });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Extra High");
      });

      await page.getByRole("menuitemradio", { name: "Medium" }).click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Extra High");
        expect(document.body.textContent ?? "").not.toContain("Fast Mode");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
