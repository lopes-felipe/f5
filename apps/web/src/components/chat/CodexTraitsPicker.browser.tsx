import "../../index.css";

import { ProviderDriverKind, ThreadId, type ServerProviderModel } from "@t3tools/contracts";
import { createReportedCodexModelCapabilities } from "@t3tools/shared/model";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CodexTraitsPicker } from "./CodexTraitsPicker";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useModelPreferencesStore } from "../../modelPreferencesStore";
import { getComposerProviderState } from "./composerProviderState";
import { providerModelOptionsToSelections } from "../../providerModelOptions";

/** Effort levels whose battery segment is currently filled, top row first. */
function filledLevels() {
  return [...document.querySelectorAll('[data-effort-filled="true"]')].map((segment) =>
    segment.closest("[data-effort-level]")?.getAttribute("data-effort-level"),
  );
}

async function mountPicker(props?: {
  model?: string;
  draftModel?: string | null;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  fastModeEnabled?: boolean;
  models?: ReadonlyArray<ServerProviderModel>;
}) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  draftsByThreadId[threadId] = {
    prompt: "",
    mentions: [],
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
    <CodexTraitsPicker
      threadId={threadId}
      model={props?.model ?? "gpt-5.6-sol"}
      {...(props?.models ? { models: props.models } : {})}
    />,
    { container: host },
  );

  return {
    threadId,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("CodexTraitsPicker", () => {
  it("starts at High and retains a selected provider default explicitly for dispatch", async () => {
    const models: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "gpt-6-luna",
        name: "GPT-6 Luna",
        isCustom: false,
        capabilities: createReportedCodexModelCapabilities({
          model: "gpt-6-luna",
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
          ],
          defaultReasoningEffort: "medium",
        }),
      },
    ];
    const mounted = await mountPicker({ model: "gpt-6-luna", models });
    try {
      await expect.element(page.getByRole("button")).toHaveAttribute("data-effort-level", "high");
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: /^Medium/ }).click();
      await expect.element(page.getByRole("button")).toHaveAttribute("data-effort-level", "medium");
      const draftOptions =
        useComposerDraftStore.getState().draftsByThreadId[mounted.threadId]?.modelOptions;
      expect(draftOptions?.codex?.reasoningEffort).toBe("medium");
      expect(
        getComposerProviderState({
          provider: ProviderDriverKind.make("codex"),
          model: "gpt-6-luna",
          models,
          modelOptions: providerModelOptionsToSelections("codex", draftOptions),
        }).modelOptionsForDispatch,
      ).toContainEqual({ id: "reasoningEffort", value: "medium" });
    } finally {
      await mounted.cleanup();
    }
  });
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

  it("shows inherited Fast and keeps an explicit off choice after reopening", async () => {
    const models: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        isCustom: false,
        capabilities: createReportedCodexModelCapabilities({
          model: "gpt-6.1-sol",
          serviceTiers: [{ id: "priority", name: "Fast" }],
          defaultServiceTier: "priority",
        }),
      },
    ];
    const mounted = await mountPicker({ model: "gpt-6.1-sol", models });
    try {
      await vi.waitFor(() =>
        expect(document.querySelector('[aria-label="Fast mode enabled"]')).not.toBeNull(),
      );
      await page.getByRole("button").click();
      await page.getByRole("menuitemcheckbox", { name: "Fast Mode" }).click();
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[mounted.threadId]?.modelOptions?.codex
            ?.fastMode,
        ).toBe(false);
        expect(document.querySelector('[aria-label="Fast mode enabled"]')).toBeNull();
      });
      await userEvent.keyboard("{Escape}");
      await page.getByRole("button").click();
      await expect
        .element(page.getByRole("menuitemcheckbox", { name: "Fast Mode" }))
        .toHaveAttribute("aria-checked", "false");
    } finally {
      await mounted.cleanup();
    }
  });

  it("ranks efforts high to low and fills the battery up to the selected level", async () => {
    const mounted = await mountPicker({ model: "gpt-6.1-sol", effort: "high" });
    const threadId = ThreadId.makeUnsafe("thread-codex-traits");

    try {
      await expect.element(page.getByRole("button")).toHaveAttribute("data-effort-level", "high");
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(
          page
            .getByRole("menuitemradio")
            .elements()
            .map((item) => item.getAttribute("data-effort-level")),
        ).toEqual(["ultra", "max", "xhigh", "high", "medium", "low"]);
        expect(filledLevels()).toEqual(["high", "medium", "low"]);
      });

      // The selection keeps a cue that survives forced colours (fills and glows
      // are overridden there), verified manually under emulated forced colours.
      const selectedSegments = document.querySelectorAll('[data-effort-selected="true"]');
      expect(selectedSegments).toHaveLength(1);
      expect(
        selectedSegments[0]?.closest("[data-effort-level]")?.getAttribute("data-effort-level"),
      ).toBe("high");
      expect(selectedSegments[0]?.className).toContain("forced-colors:bg-[color:Highlight]");

      // Highlighting a higher level previews its fill without selecting it.
      await page.getByRole("menuitemradio", { name: "Max" }).hover();
      await vi.waitFor(() => {
        expect(filledLevels()).toEqual(["max", "xhigh", "high", "medium", "low"]);
      });
      expect(
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelOptions?.codex
          ?.reasoningEffort,
      ).toBe("high");

      // Leaving the effort rows restores the selected fill.
      const fastMode = page.getByRole("menuitemcheckbox", { name: "Fast Mode" });
      await fastMode.hover();
      await vi.waitFor(() => {
        expect(filledLevels()).toEqual(["high", "medium", "low"]);
      });
      await page.getByRole("menuitemradio", { name: "Max" }).hover();
      await page.getByRole("button").hover();
      await vi.waitFor(() => {
        expect(filledLevels()).toEqual(["high", "medium", "low"]);
      });

      // Fast mode is a switch that keeps the menu open.
      await expect.element(fastMode).toHaveAttribute("aria-checked", "false");
      await fastMode.click();
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelOptions?.codex
            ?.fastMode,
        ).toBe(true);
        expect(fastMode.element().getAttribute("aria-checked")).toBe("true");
      });
      expect(page.getByRole("button").element().textContent?.trim()).toBe("High");
    } finally {
      await mounted.cleanup();
    }
  });

  it("previews keyboard navigation without previewing the item focused on open", async () => {
    const mounted = await mountPicker({ model: "gpt-6.1-sol", effort: "medium" });
    const threadId = ThreadId.makeUnsafe("thread-codex-traits");

    try {
      page.getByRole("button").element().focus();
      await userEvent.keyboard("{ArrowDown}");

      // Opening from the keyboard focuses the top row (Ultra); the fill must
      // still show the stored selection rather than a full battery.
      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("data-effort-level")).toBe("ultra");
      });
      expect(filledLevels()).toEqual(["medium", "low"]);

      // Arrowing through the rows previews each one.
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("data-effort-level")).toBe("max");
        expect(filledLevels()).toEqual(["max", "xhigh", "high", "medium", "low"]);
      });

      // Moving focus out of the effort rows restores the selected fill.
      await userEvent.keyboard("{End}");
      await vi.waitFor(() => {
        expect(document.activeElement?.getAttribute("role")).toBe("menuitemcheckbox");
        expect(filledLevels()).toEqual(["medium", "low"]);
      });
      expect(
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.modelOptions?.codex
          ?.reasoningEffort,
      ).toBe("medium");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the shown effort when fast mode is toggled with reported capabilities", async () => {
    // Stored Ultra, reported [max, high, low] with default Low: the turn runs
    // at Max, so toggling fast mode must not drop the effort and fall to Low.
    const models: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "gpt-6.1-sol",
        name: "GPT-6.1 Sol",
        isCustom: false,
        capabilities: createReportedCodexModelCapabilities({
          model: "gpt-6.1-sol",
          supportedReasoningEfforts: [
            { reasoningEffort: "max" },
            { reasoningEffort: "high" },
            { reasoningEffort: "low" },
          ],
          defaultReasoningEffort: "low",
          serviceTiers: [{ id: "fast", name: "Fast" }],
        }),
      },
    ];
    const mounted = await mountPicker({ model: "gpt-6.1-sol", effort: "ultra", models });

    try {
      await expect.element(page.getByRole("button")).toHaveTextContent("Max");
      await page.getByRole("button").click();
      await page.getByRole("menuitemcheckbox", { name: "Fast Mode" }).click();
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[mounted.threadId]?.modelOptions?.codex,
        ).toEqual({ reasoningEffort: "max", fastMode: true });
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
        expect(page.getByRole("menuitemradio").all()).toHaveLength(5);
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

  it("keeps a persisted Ultra selection for GPT-6.1 Sol", async () => {
    const mounted = await mountPicker({ model: "gpt-6.1-sol", effort: "ultra" });

    try {
      await vi.waitFor(() => {
        expect(page.getByRole("button").element().textContent?.trim()).toBe("Ultra");
      });
      await page.getByRole("button").click();
      await vi.waitFor(() => {
        expect(
          page
            .getByRole("menuitemradio", { name: "Ultra", exact: true })
            .element()
            .getAttribute("aria-checked"),
        ).toBe("true");
        expect(page.getByRole("menuitemradio").all()).toHaveLength(6);
      });
      expect(
        useComposerDraftStore.getState().draftsByThreadId[
          ThreadId.makeUnsafe("thread-codex-traits")
        ]?.modelOptions?.codex?.reasoningEffort,
      ).toBe("ultra");
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
        expect(page.getByRole("menuitemradio").all()).toHaveLength(6);
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
