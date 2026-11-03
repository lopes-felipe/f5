import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectScript, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const state = vi.hoisted(() => ({
  scripts: [] as ProjectScript[],
  keybindings: [] as ResolvedKeybindingsConfig,
  dispatchCommand: vi.fn(),
  addKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));

vi.mock("./SettingsRouteContext", () => ({
  useSettingsRouteContext: () => ({
    selectedProject: { id: "project-1", name: "Project", scripts: state.scripts },
    keybindings: state.keybindings,
  }),
}));

vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  readNativeApi: () => ({
    orchestration: { dispatchCommand: state.dispatchCommand },
    server: { addKeybinding: state.addKeybinding, removeKeybinding: state.removeKeybinding },
  }),
}));

import { serverQueryKeys } from "../../lib/serverReactQuery";
import { ProjectActionsSettings } from "./ProjectActionsSettings";

const SETUP_SCRIPT: ProjectScript = {
  id: "setup",
  name: "Install",
  command: "bun install --frozen-lockfile",
  icon: "configure",
  runOnWorktreeCreate: true,
  runOnWorktreeSettle: true,
};

let active: Awaited<ReturnType<typeof render>> | undefined;

beforeEach(() => {
  state.scripts = [];
  state.keybindings = [];
  state.dispatchCommand.mockReset().mockResolvedValue(undefined);
  state.addKeybinding.mockReset().mockResolvedValue(undefined);
  state.removeKeybinding.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

const SETUP_SHORTCUT_RULE = { key: "mod+shift+i", command: "script.setup.run" } as const;
const SETUP_SHORTCUT: ResolvedKeybindingsConfig = [
  {
    command: "script.setup.run",
    shortcut: {
      key: "i",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    },
  },
];

async function mount(options: { customKeybindings?: ReadonlyArray<unknown> } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.customKeybindings) {
    client.setQueryData(serverQueryKeys.config(), {
      customKeybindings: options.customKeybindings,
    });
  }
  active = await render(
    <QueryClientProvider client={client}>
      <ProjectActionsSettings />
    </QueryClientProvider>,
  );
}

function lastDispatchedScripts(): ProjectScript[] | undefined {
  return state.dispatchCommand.mock.calls.at(-1)?.[0]?.scripts;
}

describe("ProjectActionsSettings", () => {
  it("shows the empty state and adds an action", async () => {
    await mount();
    await expect.element(page.getByText("No actions yet.", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "Add action" }).click();
    await expect.element(page.getByRole("dialog", { name: "Add Action" })).toBeVisible();
    await page.getByLabelText("Name").fill("Test");
    await page.getByLabelText("Command").fill("bun test");
    await page.getByRole("button", { name: "Save action" }).click();

    await expect.poll(() => state.dispatchCommand.mock.calls.length).toBe(1);
    expect(state.dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "project.meta.update",
      projectId: "project-1",
    });
    expect(lastDispatchedScripts()).toEqual([
      { id: "test", name: "Test", command: "bun test", icon: "play", runOnWorktreeCreate: false },
    ]);
  });

  it("lists actions with badges and shortcuts, edits, and deletes them with their shortcut", async () => {
    state.scripts = [SETUP_SCRIPT];
    state.keybindings = SETUP_SHORTCUT;
    await mount({ customKeybindings: [SETUP_SHORTCUT_RULE] });

    await expect.element(page.getByText("Install", { exact: true })).toBeVisible();
    await expect.element(page.getByText("bun install --frozen-lockfile")).toBeVisible();
    await expect.element(page.getByText("Setup", { exact: true })).toBeVisible();
    await expect.element(page.getByText("On settle", { exact: true })).toBeVisible();
    expect(document.querySelector("kbd")?.textContent ?? "").toMatch(/i/i);

    await page.getByRole("button", { name: "Edit Install" }).click();
    await expect.element(page.getByRole("dialog", { name: "Edit Action" })).toBeVisible();
    await expect.element(page.getByLabelText("Name")).toHaveValue("Install");
    await expect.element(page.getByLabelText("Command")).toHaveValue(SETUP_SCRIPT.command);
    await expect.element(page.getByLabelText("Keybinding")).toHaveValue("mod+shift+i");

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Delete action" }).click();
    await expect.poll(() => state.dispatchCommand.mock.calls.length).toBe(1);
    expect(lastDispatchedScripts()).toEqual([]);
    await expect
      .poll(() => state.removeKeybinding.mock.calls)
      .toEqual([[{ target: SETUP_SHORTCUT_RULE }]]);
    expect(state.addKeybinding).not.toHaveBeenCalled();
  });

  it("re-saves an edited action's shortcut", async () => {
    state.scripts = [SETUP_SCRIPT];
    state.keybindings = SETUP_SHORTCUT;
    await mount({ customKeybindings: [SETUP_SHORTCUT_RULE] });

    await page.getByRole("button", { name: "Edit Install" }).click();
    await page.getByLabelText("Command").fill("bun install");
    await page.getByRole("button", { name: "Save changes" }).click();

    await expect
      .poll(() => state.addKeybinding.mock.calls)
      .toEqual([[{ rule: SETUP_SHORTCUT_RULE }]]);
    expect(state.removeKeybinding.mock.calls).toEqual([[{ target: SETUP_SHORTCUT_RULE }]]);
    expect(lastDispatchedScripts()).toEqual([{ ...SETUP_SCRIPT, command: "bun install" }]);
  });

  it("moves the setup flag to a new setup action that the agent waits for", async () => {
    state.scripts = [SETUP_SCRIPT];
    await mount();

    await page.getByRole("button", { name: "Add action" }).click();
    await page.getByLabelText("Name").fill("Seed");
    await page.getByLabelText("Command").fill("bun run seed");
    await page.getByRole("switch", { name: "Run automatically on worktree creation" }).click();
    await page.getByRole("switch", { name: "Agent waits for this script" }).click();
    await page.getByRole("button", { name: "Save action" }).click();

    await expect.poll(() => state.dispatchCommand.mock.calls.length).toBe(1);
    expect(lastDispatchedScripts()).toEqual([
      { ...SETUP_SCRIPT, runOnWorktreeCreate: false },
      {
        id: "seed",
        name: "Seed",
        command: "bun run seed",
        icon: "play",
        runOnWorktreeCreate: true,
        async: false,
      },
    ]);
  });
});
