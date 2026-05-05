import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ModelSlug, ProviderKind, ServerProvider } from "@t3tools/contracts";

import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelPickerModelOption } from "./providerIconUtils";
import { parsePersistedAppSettings } from "../../appSettings";
import { useModelPreferencesStore } from "../../modelPreferencesStore";
import { createTestServerProvider } from "../../testServerProvider";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const NOW_ISO = "2026-05-04T12:00:00.000Z";

const READY_PROVIDERS: ServerProvider[] = [
  createTestServerProvider("codex", { checkedAt: NOW_ISO }),
  createTestServerProvider("claudeAgent", { checkedAt: NOW_ISO }),
  createTestServerProvider("cursor", { checkedAt: NOW_ISO }),
  createTestServerProvider("opencode", { checkedAt: NOW_ISO }),
];

const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    { slug: "gpt-5.5", name: "GPT-5.5" },
    { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
    { slug: "openai/gpt-oss-120b", name: "openai/gpt-oss-120b", subProvider: "OpenAI" },
  ],
  claudeAgent: [
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", shortName: "Sonnet 4.6" },
    { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", shortName: "Haiku 4.5" },
  ],
  cursor: [{ slug: "auto", name: "Auto" }],
  opencode: [{ slug: "openai/gpt-5", name: "OpenAI GPT-5" }],
} satisfies Record<ProviderKind, ReadonlyArray<ModelPickerModelOption>>;

async function mountPicker(props?: {
  provider?: ProviderKind;
  model?: ModelSlug;
  lockedProvider?: ProviderKind | null;
  providers?: ServerProvider[];
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const onProviderModelChange = vi.fn<(provider: ProviderKind, model: ModelSlug) => void>();
  const screen = await render(
    <ProviderModelPicker
      provider={props?.provider ?? "codex"}
      model={props?.model ?? "gpt-5.5"}
      lockedProvider={props?.lockedProvider ?? null}
      providers={props?.providers ?? READY_PROVIDERS}
      modelOptionsByProvider={MODEL_OPTIONS_BY_PROVIDER}
      keybindings={[
        {
          command: "modelPicker.jump.1",
          shortcut: {
            key: "1",
            metaKey: false,
            ctrlKey: true,
            shiftKey: false,
            altKey: false,
            modKey: false,
          },
          whenAst: { type: "identifier", name: "modelPickerOpen" },
        },
      ]}
      onProviderModelChange={onProviderModelChange}
    />,
    { container: host },
  );

  return {
    onProviderModelChange,
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function readStoredFavoriteModels() {
  return parsePersistedAppSettings(localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).favoriteModels;
}

describe("ProviderModelPicker", () => {
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
  });

  it("opens from the trigger, focuses search, and filters across providers", async () => {
    const mounted = await mountPicker();

    try {
      await page.getByRole("button", { name: /GPT-5.5/ }).click();

      await vi.waitFor(() => {
        const activeElement = document.activeElement;
        expect(activeElement).toBeInstanceOf(HTMLInputElement);
        expect((activeElement as HTMLInputElement).placeholder).toBe("Search models...");
      });

      await page.getByPlaceholder("Search models...").fill("sonnet");

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Sonnet 4.6");
        expect(text).not.toContain("GPT-5.4 Mini");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("persists star and unstar changes as favorite models", async () => {
    const mounted = await mountPicker();

    try {
      await page.getByRole("button", { name: /GPT-5.5/ }).click();
      await page.getByRole("button", { name: "Add to favorites" }).first().click();

      await vi.waitFor(() => {
        expect(readStoredFavoriteModels()).toEqual([{ providerKind: "codex", modelId: "gpt-5.5" }]);
      });

      await page.getByRole("button", { name: "Remove from favorites" }).first().click();

      await vi.waitFor(() => {
        expect(readStoredFavoriteModels()).toEqual([]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps unavailable providers visible but disables their models", async () => {
    const mounted = await mountPicker({
      providers: [
        READY_PROVIDERS[0]!,
        createTestServerProvider("claudeAgent", {
          status: "error",
          availability: "unavailable",
          auth: { status: "unauthenticated" },
          checkedAt: NOW_ISO,
          message: "Claude unavailable",
        }),
      ],
    });

    try {
      await page.getByRole("button", { name: /GPT-5.5/ }).click();
      await page.getByPlaceholder("Search models...").fill("sonnet");

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Sonnet 4.6");
        expect(text).toContain("Claude unavailable");
      });

      await page.getByText("Sonnet 4.6").click({ force: true });
      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("selects the visible row targeted by a jump shortcut", async () => {
    const mounted = await mountPicker();

    try {
      await page.getByRole("button", { name: /GPT-5.5/ }).click();
      await page.getByPlaceholder("Search models...").fill("haiku");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Haiku 4.5");
      });

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
          "claudeAgent",
          "claude-haiku-4-5",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not run jump shortcuts while the search input has focus", async () => {
    const mounted = await mountPicker();

    try {
      await page.getByRole("button", { name: /GPT-5.5/ }).click();
      await page.getByPlaceholder("Search models...").fill("haiku");

      const input = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search models..."]',
      );
      expect(input).not.toBeNull();
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "1",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(mounted.onProviderModelChange).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("rejects cross-provider selection for locked threads", async () => {
    const mounted = await mountPicker({
      provider: "codex",
      model: "gpt-5.5",
      lockedProvider: "codex",
    });

    try {
      await page.getByRole("button", { name: /GPT-5.5/ }).click();
      await page.getByPlaceholder("Search models...").fill("sonnet");

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("No models found");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
