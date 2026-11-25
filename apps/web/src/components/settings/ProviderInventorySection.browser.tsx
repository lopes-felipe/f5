import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ProviderInstanceId,
  type ProviderInstanceInventory,
  type ServerTrustProviderHooksInput,
} from "@t3tools/contracts";
import { ProviderInventorySection } from "./ProviderInventorySection";

const mocks = vi.hoisted(() => ({
  getProviderInventory: vi.fn(),
  trustProviderHooks: vi.fn(),
  projects: [] as Array<{ id: string; name: string }>,
}));

vi.mock("../../store", () => ({
  useStore: (select: (state: unknown) => unknown) => select({ projects: mocks.projects }),
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
    trustToken: "token-core-start",
  },
  {
    key: "user-stop",
    event: "stop",
    program: "notify",
    source: "instance",
    trustStatus: "untrusted",
    trustToken: "token-user-stop",
  },
  { key: "ok", event: "preToolUse", source: "instance", trustStatus: "trusted" },
  { key: "policy", event: "stop", source: "managed", trustStatus: "managed" },
  // Older CLIs report no trust status: no badge, no action.
  { key: "legacy", event: "stop", source: "instance" },
];

function result(
  overrides: Partial<Record<"trusted" | "skipped" | "changed" | "failed", string[]>>,
) {
  return { trusted: [], skipped: [], changed: [], failed: [], ...overrides };
}

function allTrusted(hooks: ProviderInstanceInventory["hooks"]) {
  return hooks.map((hook) => {
    if (hook.trustStatus !== "modified" && hook.trustStatus !== "untrusted") return hook;
    const { trustToken: _token, ...rest } = hook;
    return { ...rest, trustStatus: "trusted" as const };
  });
}

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.getProviderInventory.mockReset();
  mocks.trustProviderHooks.mockReset();
  mocks.projects = [];
});
afterEach(() => {
  client.clear();
  document.body.innerHTML = "";
});

async function renderSection(props: { focusProjectId?: string } = {}) {
  const screen = await render(
    <QueryClientProvider client={client}>
      <ProviderInventorySection
        instanceId={ProviderInstanceId.makeUnsafe("codex")}
        {...(props.focusProjectId
          ? { focusHooks: true, focusProjectId: props.focusProjectId }
          : {})}
      />
    </QueryClientProvider>,
  );
  if (!props.focusProjectId) {
    await page.getByText("Hooks, plugins and connectors", { exact: true }).click();
  }
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

it("badges hooks that need approval and trusts them, with their tokens, after confirmation", async () => {
  mocks.getProviderInventory
    .mockResolvedValueOnce(inventory({ hooks: HOOKS }))
    .mockResolvedValue(inventory({ hooks: allTrusted(HOOKS) }));
  mocks.trustProviderHooks.mockResolvedValue(result({ trusted: ["core-start", "user-stop"] }));
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
    await expect.element(dialog.getByText(/already running pick it up/)).toBeVisible();
    await expect.element(dialog.getByText(CORE_PATH)).toBeVisible();
    await expect.element(dialog.getByText("python3 · core@workspace-directory")).toBeVisible();

    await dialog.getByRole("button", { name: "Trust 2 hooks" }).click();
    expect(mocks.trustProviderHooks).toHaveBeenCalledWith({
      instanceId: "codex",
      hooks: [
        { key: "core-start", token: "token-core-start" },
        { key: "user-stop", token: "token-user-stop" },
      ],
    });
    await expect.element(page.getByRole("status")).toHaveTextContent("Trusted 2 hooks.");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("keep skipping them until their Codex session restarts");
    await expect.element(page.getByRole("button", { name: /Trust all/ })).not.toBeInTheDocument();
    await expect.element(page.getByText("Needs approval")).not.toBeInTheDocument();
    expect(mocks.getProviderInventory).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
});

it("reports changed and still-untrusted hooks instead of claiming success", async () => {
  mocks.getProviderInventory.mockResolvedValue(inventory({ hooks: HOOKS }));
  mocks.trustProviderHooks.mockResolvedValue(
    result({ changed: ["core-start"], failed: ["user-stop"] }),
  );
  const screen = await renderSection();
  try {
    await page.getByRole("button", { name: "Trust all (2)" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Trust 2 hooks" }).click();
    const alert = page.getByRole("alert");
    await expect.element(alert).toHaveTextContent("1 hook changed since this list loaded");
    await expect.element(alert).toHaveTextContent("Codex still reports 1 hook as needing approval");
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
    // The list is re-read so the badges reflect what Codex now reports.
    expect(mocks.getProviderInventory).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
});

it("says so when nothing needed approval any more", async () => {
  mocks.getProviderInventory.mockResolvedValue(inventory({ hooks: HOOKS }));
  mocks.trustProviderHooks.mockResolvedValue(result({ skipped: ["core-start"] }));
  const screen = await renderSection();
  try {
    await page.getByRole("button", { name: "Trust", exact: true }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Trust hook" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Nothing to trust: these hooks no longer need approval.");
  } finally {
    await screen.unmount();
  }
});

it("trusts more hooks than one request allows in batches", async () => {
  const many = Array.from({ length: 65 }, (_, index) => ({
    key: `hook-${index}`,
    event: "stop",
    source: "plugin" as const,
    trustStatus: "modified" as const,
    trustToken: `token-${index}`,
  }));
  mocks.getProviderInventory.mockResolvedValue(inventory({ hooks: many }));
  mocks.trustProviderHooks.mockImplementation(async (input: ServerTrustProviderHooksInput) =>
    result({ trusted: input.hooks.map((hook) => hook.key) }),
  );
  const screen = await renderSection();
  try {
    await page.getByRole("button", { name: "Trust all (65)" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Trust 65 hooks" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("Trusted 65 hooks.");
    expect(mocks.trustProviderHooks).toHaveBeenCalledTimes(2);
    expect(mocks.trustProviderHooks.mock.calls.map(([input]) => input.hooks.length)).toEqual([
      64, 1,
    ]);
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
      hooks: [{ key: "core-start", token: "token-core-start" }],
    });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("features.chronicle=true is not allowed by requirements");
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    // A failed or timed-out reply may still have saved the approval: re-read.
    expect(mocks.getProviderInventory).toHaveBeenCalledTimes(2);
  } finally {
    await screen.unmount();
  }
});

it("opens on a link's project so project-scoped hooks can be approved", async () => {
  mocks.projects = [{ id: "project-1", name: "Repo" }];
  mocks.getProviderInventory.mockResolvedValue(inventory({ hooks: HOOKS }));
  const screen = await renderSection({ focusProjectId: "project-1" });
  try {
    await expect.element(page.getByText("Needs approval").first()).toBeVisible();
    expect(mocks.getProviderInventory).toHaveBeenCalledWith({
      instanceId: "codex",
      projectId: "project-1",
    });
    await expect
      .element(page.getByRole("combobox", { name: "Project for project-shared entries" }))
      .toHaveValue("project-1");
  } finally {
    await screen.unmount();
  }
});
