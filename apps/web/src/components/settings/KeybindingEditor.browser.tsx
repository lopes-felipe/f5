import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeApi, ServerKeybindingMutationResult } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsRouteContext } from "./SettingsRouteContext";
import type { SettingsRouteValue } from "./useSettingsRouteState";
import { KeybindingEditor } from "./KeybindingEditor";

const { nativeApiRef } = vi.hoisted(() => ({
  nativeApiRef: {
    current: undefined as NativeApi | undefined,
  },
}));

vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => {
    if (!nativeApiRef.current) {
      throw new Error("Native API not found");
    }
    return nativeApiRef.current;
  },
}));

const addKeybinding = vi.fn();
const updateKeybinding = vi.fn();
const removeKeybinding = vi.fn();
const resetKeybindings = vi.fn();

function mutationResult(): ServerKeybindingMutationResult {
  return {
    keybindings: [],
    customKeybindings: [],
    issues: [],
  };
}

function renderEditor(overrides: Partial<SettingsRouteValue> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const value = {
    keybindings: [
      {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
      {
        command: "commandPalette.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      },
    ],
    customKeybindings: [{ key: "mod+j", command: "terminal.toggle" }],
    keybindingConflicts: [],
    projects: [],
    ...overrides,
  } as unknown as SettingsRouteValue;

  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsRouteContext.Provider value={value}>
        <KeybindingEditor />
      </SettingsRouteContext.Provider>
    </QueryClientProvider>,
  );
}

describe("KeybindingEditor", () => {
  afterEach(() => {
    nativeApiRef.current = undefined;
    vi.restoreAllMocks();
    addKeybinding.mockReset();
    updateKeybinding.mockReset();
    removeKeybinding.mockReset();
    resetKeybindings.mockReset();
    document.body.innerHTML = "";
  });

  it("renders custom remove controls only for custom rows", async () => {
    const screen = await renderEditor();
    try {
      await expect.element(page.getByText("Toggle terminal")).toBeInTheDocument();
      await expect.element(page.getByLabelText("Remove Toggle terminal")).toBeInTheDocument();
      await expect.element(page.getByText("Toggle command palette")).toBeInTheDocument();
      await expect
        .element(page.getByLabelText("Remove Toggle command palette"))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("filters rows by search query", async () => {
    const screen = await renderEditor();
    try {
      await page.getByLabelText("Search keybindings").fill("terminal");
      await expect.element(page.getByText("Toggle terminal")).toBeInTheDocument();
      await expect.element(page.getByText("Toggle command palette")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("validates invalid when expressions before submitting", async () => {
    nativeApiRef.current = {
      server: {
        addKeybinding,
        updateKeybinding,
        removeKeybinding,
        resetKeybindings,
      },
    } as unknown as NativeApi;
    const screen = await renderEditor();
    try {
      await page.getByLabelText("Edit Toggle terminal").click();
      await page.getByLabelText("When expression").fill("a && && b");
      await page.getByRole("button", { name: "Save" }).click();
      await expect
        .element(page.getByText("Use variables with !, &&, ||, and parentheses."))
        .toBeInTheDocument();
      expect(updateKeybinding).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("submits exact update and reset RPCs", async () => {
    updateKeybinding.mockResolvedValue(mutationResult());
    resetKeybindings.mockResolvedValue(mutationResult());
    nativeApiRef.current = {
      server: {
        addKeybinding,
        updateKeybinding,
        removeKeybinding,
        resetKeybindings,
      },
    } as unknown as NativeApi;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const screen = await renderEditor();
    try {
      await page.getByLabelText("Edit Toggle terminal").click();
      await page.getByLabelText("Shortcut").fill("mod+t");
      await page.getByRole("button", { name: "Save" }).click();
      expect(updateKeybinding).toHaveBeenCalledWith({
        target: { key: "mod+j", command: "terminal.toggle" },
        rule: { key: "mod+t", command: "terminal.toggle" },
      });

      await page.getByRole("button", { name: "Reset all" }).click();
      expect(resetKeybindings).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
