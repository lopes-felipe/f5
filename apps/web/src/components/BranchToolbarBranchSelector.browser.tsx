import "../index.css";

import { ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { WsRequestError } from "../wsTransport";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";

const api = vi.hoisted(() => ({
  listBranches: vi.fn(),
  status: vi.fn(),
  checkout: vi.fn(),
  prepareWorktree: vi.fn(),
}));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ git: api }),
  ensureNativeApi: () => ({ git: api }),
}));
vi.mock("../appSettings", () => ({
  useAppSettings: () => ({ settings: { gitStatusAutoRefreshIntervalSeconds: 0 } }),
}));

const cwd = "/repo/worktrees/thread";
const conflict = { cwd, branch: "main", files: ["index.css", "ChatComposer.tsx"] };
let screen: Awaited<ReturnType<typeof render>> | undefined;
let client: QueryClient | undefined;
const onSetThreadBranch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  api.listBranches.mockResolvedValue({
    isRepo: true,
    hasOriginRemote: false,
    branches: [
      { name: "thread", current: true, isDefault: false, worktreePath: cwd },
      { name: "main", current: false, isDefault: true, worktreePath: null },
    ],
  });
  api.status.mockResolvedValue({ branch: "thread" });
  api.checkout.mockResolvedValue(undefined);
});
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  client?.clear();
});

const selector = (
  overrides: Partial<React.ComponentProps<typeof BranchToolbarBranchSelector>> = {},
) => (
  <QueryClientProvider client={client!}>
    <BranchToolbarBranchSelector
      threadId={ThreadId.makeUnsafe("thread-1")}
      workspaceVersion="session-1"
      canApplyWorkspace={() => true}
      activeProjectCwd="/repo"
      activeThreadBranch="thread"
      activeWorktreePath={cwd}
      branchCwd={cwd}
      effectiveEnvMode="worktree"
      envLocked={false}
      onSetThreadBranch={onSetThreadBranch}
      {...overrides}
    />
  </QueryClientProvider>
);

async function openMain(
  overrides: Partial<React.ComponentProps<typeof BranchToolbarBranchSelector>> = {},
) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  screen = await render(selector(overrides));
  await page.getByText("thread", { exact: true }).click();
  await page.getByText("main", { exact: true }).click();
}

async function selectMain() {
  await openMain();
  await page.getByRole("button", { name: "Use this workspace", exact: true }).click();
  await expect.poll(() => api.checkout.mock.calls.length).toBe(1);
}

describe("branch checkout recovery", () => {
  it("checks out main in the selected worktree and keeps the thread there", async () => {
    await selectMain();
    await expect.poll(() => onSetThreadBranch.mock.calls).toEqual([["main", cwd]]);
    expect(api.checkout).toHaveBeenCalledWith({ cwd, branch: "main" });
  });

  it("shows affected files and cancels without changing the thread or creating a worktree", async () => {
    api.checkout.mockRejectedValue(new WsRequestError("Blocked", "GitCheckoutConflict", conflict));
    await selectMain();
    await expect
      .element(page.getByRole("heading", { name: "Local changes block branch switch" }))
      .toBeVisible();
    await expect.element(page.getByText(cwd, { exact: true })).toBeVisible();
    await expect.element(page.getByText("index.css", { exact: true })).toBeVisible();
    await expect.element(page.getByText("ChatComposer.tsx", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Local changes block branch switch" }))
      .not.toBeInTheDocument();
    expect(onSetThreadBranch).not.toHaveBeenCalled();
    expect(api.prepareWorktree).not.toHaveBeenCalled();
  });

  it("keeps context after failed recovery and attaches the worktree only after successful retry", async () => {
    api.checkout.mockRejectedValue(new WsRequestError("Blocked", "GitCheckoutConflict", conflict));
    api.prepareWorktree.mockRejectedValueOnce(new Error("Worktree setup failed"));
    await selectMain();
    await page.getByRole("button", { name: "Open in a separate worktree" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Worktree setup failed");
    expect(onSetThreadBranch).not.toHaveBeenCalled();

    let resolve!: (value: { worktree: { branch: string; path: string } }) => void;
    api.prepareWorktree.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await page.getByRole("button", { name: "Open in a separate worktree" }).click();
    await expect.poll(() => api.prepareWorktree.mock.calls.length).toBe(2);
    expect(onSetThreadBranch).not.toHaveBeenCalled();
    expect(api.prepareWorktree).toHaveBeenLastCalledWith({
      cwd,
      branch: "main",
      newBranch: expect.stringMatching(/^t3code\/[a-f0-9]{8}$/),
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectCwd: "/repo",
    });
    expect(api.prepareWorktree.mock.calls[0]?.[0]).toEqual(api.prepareWorktree.mock.calls[1]?.[0]);
    resolve({ worktree: { branch: "t3code/new", path: "/repo/worktrees/new" } });
    await expect
      .poll(() => onSetThreadBranch.mock.calls)
      .toEqual([["t3code/new", "/repo/worktrees/new"]]);
    expect(api.checkout).toHaveBeenCalledTimes(1);
  });
});

describe("recovery ownership and workspace choices", () => {
  it("shows the target workspace before checkout and offers an isolated branch", async () => {
    api.prepareWorktree.mockResolvedValue({
      worktree: { branch: "t3code/new", path: "/repo/new" },
    });
    await openMain();
    await expect.element(page.getByText(cwd, { exact: true })).toBeVisible();
    expect(api.checkout).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Open a separate worktree", exact: true }).click();
    await page.getByRole("button", { name: "Open in a separate worktree", exact: true }).click();
    await expect.poll(() => onSetThreadBranch.mock.calls).toEqual([["t3code/new", "/repo/new"]]);
    expect(api.checkout).not.toHaveBeenCalled();
  });

  it("shows the project root before reusing main there", async () => {
    api.listBranches.mockResolvedValue({
      isRepo: true,
      hasOriginRemote: false,
      branches: [
        { name: "thread", current: true, isDefault: false, worktreePath: cwd },
        { name: "main", current: false, isDefault: true, worktreePath: "/repo" },
      ],
    });
    await openMain();
    await expect.element(page.getByText("/repo", { exact: true })).toBeVisible();
    expect(onSetThreadBranch).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Use this workspace", exact: true }).click();
    await expect.poll(() => onSetThreadBranch.mock.calls).toEqual([["main", null]]);
    expect(api.checkout).not.toHaveBeenCalled();
  });

  for (const scenario of [
    "navigate away and back",
    "change session",
    "change branch",
    "change workspace",
    "change environment",
  ]) {
    it(`does not apply delayed recovery after ${scenario}`, async () => {
      api.checkout.mockRejectedValue(
        new WsRequestError("Blocked", "GitCheckoutConflict", conflict),
      );
      let resolve!: (value: { worktree: { branch: string; path: string } }) => void;
      api.prepareWorktree.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await selectMain();
      await page.getByRole("button", { name: "Open in a separate worktree" }).click();
      await expect.poll(() => api.prepareWorktree.mock.calls.length).toBe(1);
      if (scenario === "navigate away and back") {
        await screen!.rerender(<div>Away</div>);
        await screen!.rerender(selector());
      } else {
        await screen!.rerender(
          selector({
            ...(scenario === "change session" ? { workspaceVersion: "session-2" } : {}),
            ...(scenario === "change branch" ? { activeThreadBranch: "newer" } : {}),
            ...(scenario === "change workspace" ? { activeWorktreePath: "/repo/newer" } : {}),
            ...(scenario === "change environment" ? { effectiveEnvMode: "local" } : {}),
          }),
        );
      }
      resolve({ worktree: { branch: "t3code/stale", path: "/repo/stale" } });
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      expect(onSetThreadBranch).not.toHaveBeenCalled();
    });
  }

  it("checks the live store before attaching even when React has not rerendered", async () => {
    let current = true;
    api.checkout.mockRejectedValue(new WsRequestError("Blocked", "GitCheckoutConflict", conflict));
    let resolve!: (value: { worktree: { branch: string; path: string } }) => void;
    api.prepareWorktree.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await openMain({ canApplyWorkspace: () => current });
    await page.getByRole("button", { name: "Use this workspace", exact: true }).click();
    await page.getByRole("button", { name: "Open in a separate worktree" }).click();
    await expect.poll(() => api.prepareWorktree.mock.calls.length).toBe(1);
    current = false;
    resolve({ worktree: { branch: "t3code/stale", path: "/repo/stale" } });
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    expect(onSetThreadBranch).not.toHaveBeenCalled();
  });
});

describe("local and remote checkout recovery", () => {
  it("moves a local draft to worktree mode only after preparation succeeds", async () => {
    api.checkout.mockRejectedValue(
      new WsRequestError("Blocked", "GitCheckoutConflict", { ...conflict, cwd: "/repo" }),
    );
    api.prepareWorktree.mockResolvedValue({
      worktree: { branch: "t3code/new", path: "/repo/new" },
    });
    await openMain({ activeWorktreePath: null, branchCwd: "/repo", effectiveEnvMode: "local" });
    await page.getByRole("button", { name: "Use this workspace", exact: true }).click();
    expect(onSetThreadBranch).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Open in a separate worktree" }).click();
    await expect.poll(() => onSetThreadBranch.mock.calls).toEqual([["t3code/new", "/repo/new"]]);
    expect(api.prepareWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", projectCwd: "/repo", branch: "main" }),
    );
  });

  it("keeps the remote ref as the recovery base", async () => {
    api.listBranches.mockResolvedValue({
      isRepo: true,
      hasOriginRemote: true,
      branches: [
        { name: "thread", current: true, isDefault: false, worktreePath: cwd },
        {
          name: "origin/x",
          current: false,
          isDefault: false,
          isRemote: true,
          remoteName: "origin",
          worktreePath: null,
        },
      ],
    });
    api.checkout.mockRejectedValue(
      new WsRequestError("Blocked", "GitCheckoutConflict", { ...conflict, branch: "origin/x" }),
    );
    api.prepareWorktree.mockResolvedValue({
      worktree: { branch: "t3code/new", path: "/repo/new" },
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    screen = await render(selector());
    await page.getByText("thread", { exact: true }).click();
    await page.getByText("origin/x", { exact: true }).click();
    await page.getByRole("button", { name: "Open in a separate worktree" }).click();
    await expect.poll(() => onSetThreadBranch.mock.calls).toEqual([["t3code/new", "/repo/new"]]);
    expect(api.prepareWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, branch: "origin/x" }),
    );
  });
});
