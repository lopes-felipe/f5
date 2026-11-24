import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProviderInstanceId, type ProviderInstanceInventory } from "@t3tools/contracts";
import { ProviderInventorySection } from "./ProviderInventorySection";

const mocks = vi.hoisted(() => ({
  getProviderInventory: vi.fn(),
  trustProviderHooks: vi.fn(),
}));

vi.mock("../../store", () => ({
  useStore: (select: (state: unknown) => unknown) => select({ projects: [] }),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({
    server: {
      getProviderInventory: mocks.getProviderInventory,
      trustProviderHooks: mocks.trustProviderHooks,
    },
  }),
}));

const CORE_PATH = "/Users/me/.codex/plugins/cache/workspace-directory/core/5.3/hooks/hooks.json";

function inventory(overrides: Partial<ProviderInstanceInventory> = {}): ProviderInstanceInventory {
  return {
    instanceId: ProviderInstanceId.makeUnsafe("codex"),
    driver: "codex" as ProviderInstanceInventory["driver"],
    generatedAt: "2026-11-03T00:00:00Z",
    hooks: [],
    plugins: [],
    connectors: [],
    agents: [],
    warnings: [],
    ...overrides,
  };
}

const HOOKS: ProviderInstanceInventory["hooks"] = [
  {
    key: "core-start",
    event: "sessionStart",
    program: "python3",
    pluginId: "core@workspace-directory",
    source: "plugin",
    sourcePath: CORE_PATH,
    trustStatus: "modified",
  },
  {
    key: "user-stop",
    event: "stop",
    program: "notify",
    source: "instance",
    trustStatus: "untrusted",
  },
  { key: "ok", event: "preToolUse", source: "instance", trustStatus: "trusted" },
  { key: "policy", event: "stop", source: "managed", trustStatus: "managed" },
  // Older CLIs report no trust status: no badge, no action.
  { key: "legacy", event: "stop", source: "instance" },
];

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.getProviderInventory.mockReset();
  mocks.trustProviderHooks.mockReset();
});
afterEach(() => {
  client.clear();
  document.body.innerHTML = "";
});

async function renderSection() {
  const screen = await render(
    <QueryClientProvider client={client}>
      <ProviderInventorySection instanceId={ProviderInstanceId.makeUnsafe("codex")} />
    </QueryClientProvider>,
  );
  await page.getByText("Hooks, plugins and connectors", { exact: true }).click();
  return screen;
}

it("shows read-only account workspaces and Vertex AI account labels", async () => {
  mocks.getProviderInventory.mockResolvedValue(
    inventory({
      accountWorkspaces: [{ name: "Engineering", kind: "workspace", active: true }],
      account: { type: "gcp", workspaceName: "Engineering" },
    }),
  );
  const screen = await renderSection();
  try {
    await expect.element(page.getByText(/Account workspaces/)).toBeVisible();
    await expect.element(page.getByText(/workspace · Active/)).toBeVisible();
    await expect.element(page.getByText(/Google Vertex AI/)).toBeVisible();
    await expect.element(page.getByText("Needs approval")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("badges hooks that need approval and trusts them after confirmation", async () => {
  mocks.getProviderInventory.mockResolvedValueOnce(inventory({ hooks: HOOKS })).mockResolvedValue(
    inventory({
      hooks: HOOKS.map((hook) =>
        hook.trustStatus === "modified" || hook.trustStatus === "untrusted"
          ? { ...hook, trustStatus: "trusted" as const }
          : hook,
      ),
    }),
  );
  mocks.trustProviderHooks.mockResolvedValue({ trusted: ["core-start", "user-stop"], skipped: [] });
  const screen = await renderSection();
  try {
    await expect.element(page.getByText("Needs approval").nth(1)).toBeVisible();
    expect(page.getByText("Needs approval").all()).toHaveLength(2);
    expect(page.getByRole("button", { name: "Trust", exact: true }).all()).toHaveLength(2);

    await page.getByRole("button", { name: "Trust all (2)" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("Trust these 2 hooks?")).toBeVisible();
    await expect
      .element(dialog.getByText(/run their commands on every matching event/))
      .toBeVisible();
    await expect.element(dialog.getByText(CORE_PATH)).toBeVisible();
    await expect.element(dialog.getByText("python3 · core@workspace-directory")).toBeVisible();

    await dialog.getByRole("button", { name: "Trust 2 hooks" }).click();
    expect(mocks.trustProviderHooks).toHaveBeenCalledWith({
      instanceId: "codex",
      keys: ["core-start", "user-stop"],
    });
    await expect.element(page.getByRole("button", { name: /Trust all/ })).not.toBeInTheDocument();
    await expect.element(page.getByText("Needs approval")).not.toBeInTheDocument();
    expect(mocks.getProviderInventory).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
});

it("trusts one hook and shows Codex's write error inline", async () => {
  mocks.getProviderInventory.mockResolvedValue(inventory({ hooks: HOOKS }));
  mocks.trustProviderHooks.mockRejectedValue(
    new Error("Invalid configuration: features.chronicle=true is not allowed by requirements"),
  );
  const screen = await renderSection();
  try {
    await page.getByRole("button", { name: "Trust", exact: true }).first().click();
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByText("Trust this hook?")).toBeVisible();
    await dialog.getByRole("button", { name: "Trust hook" }).click();
    expect(mocks.trustProviderHooks).toHaveBeenCalledWith({
      instanceId: "codex",
      keys: ["core-start"],
    });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("features.chronicle=true is not allowed by requirements");
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
