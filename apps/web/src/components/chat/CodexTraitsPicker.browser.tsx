import "../../index.css";

import { ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CodexTraitsPicker } from "./CodexTraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useModelPreferencesStore } from "../../modelPreferencesStore";

async function mountPicker(props?: {
  model?: string;
  draftModel?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
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
    providerInstanceId: null,
    model: props?.draftModel === undefined ? (props?.model ?? "gpt-5.6-sol") : props.draftModel,
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
  const screen = await render(
    <CodexTraitsPicker threadId={threadId} model={props?.model ?? "gpt-5.6-sol"} />,
    { container: host },
  );

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

  it("shows fast mode as a bolt without changing the reasoning label", async () => {
    const mounted = await mountPicker({ effort: "high", fastModeEnabled: true });

    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[aria-label="Fast mode enabled"]')).not.toBeNull();
        expect(page.getByRole("button").element().textContent?.trim()).toBe("High");
      });
    } finally {
      await mounted.cleanup();
    }
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

  it("omits Ultra for Astra and normalizes a persisted Ultra selection to Max", async () => {
    const mounted = await mountPicker({ model: "gpt-6-astra", effort: "ultra" });

    try {
      await vi.waitFor(() => {
        expect(page.getByRole("button").element().textContent?.trim()).toBe("Max");
      });
      await page.getByRole("button").click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Ultra");
        expect(document.body.textContent ?? "").toContain("Max");
        expect(page.getByRole("menuitemradio").all()).toHaveLength(7);
      });
      await page.getByRole("menuitemradio", { name: "Max" }).click();
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[
            ThreadId.makeUnsafe("thread-codex-traits")
          ]?.modelOptions?.codex?.reasoningEffort,
        ).toBe("max");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps Ultra available for GPT-5.6 Sol", async () => {
    const mounted = await mountPicker({ model: "gpt-5.6-sol" });

    try {
      await page.getByRole("button").click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Ultra");
        expect(page.getByRole("menuitemradio").all()).toHaveLength(8);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("records trait changes against the resolved model when the draft model is unset", async () => {
    useModelPreferencesStore.setState({
      lastModelByProvider: { codex: "gpt-5.6-sol" },
      recentModelSelections: [],
    });
    const mounted = await mountPicker({ model: "gpt-6-astra", draftModel: null });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Medium" }).click();
      await vi.waitFor(() => {
        expect(useModelPreferencesStore.getState().recentModelSelections[0]).toMatchObject({
          provider: "codex",
          model: "gpt-6-astra",
          options: { reasoningEffort: "medium" },
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
