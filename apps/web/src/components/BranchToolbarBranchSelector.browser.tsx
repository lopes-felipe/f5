import "../index.css";

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
  createWorktree: vi.fn(),
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

async function selectMain() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  screen = await render(
    <QueryClientProvider client={client}>
      <BranchToolbarBranchSelector
        activeProjectCwd="/repo"
        activeThreadBranch="thread"
        activeWorktreePath={cwd}
        branchCwd={cwd}
        effectiveEnvMode="worktree"
        envLocked={false}
        onSetThreadBranch={onSetThreadBranch}
      />
    </QueryClientProvider>,
  );
  await page.getByText("thread", { exact: true }).click();
  await page.getByText("main", { exact: true }).click();
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
    expect(api.createWorktree).not.toHaveBeenCalled();
  });

  it("keeps context after failed recovery and attaches the worktree only after successful retry", async () => {
    api.checkout.mockRejectedValue(new WsRequestError("Blocked", "GitCheckoutConflict", conflict));
    api.createWorktree.mockRejectedValueOnce(new Error("Worktree setup failed"));
    await selectMain();
    await page.getByRole("button", { name: "Open in a separate worktree" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Worktree setup failed");
    expect(onSetThreadBranch).not.toHaveBeenCalled();

    let resolve!: (value: { worktree: { branch: string; path: string } }) => void;
    api.createWorktree.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await page.getByRole("button", { name: "Open in a separate worktree" }).click();
    await expect.poll(() => api.createWorktree.mock.calls.length).toBe(2);
    expect(onSetThreadBranch).not.toHaveBeenCalled();
    expect(api.createWorktree).toHaveBeenLastCalledWith({
      cwd,
      branch: "main",
      newBranch: expect.stringMatching(/^t3code\/[a-f0-9]{8}$/),
      path: null,
    });
    resolve({ worktree: { branch: "t3code/new", path: "/repo/worktrees/new" } });
    await expect
      .poll(() => onSetThreadBranch.mock.calls)
      .toEqual([["t3code/new", "/repo/worktrees/new"]]);
    expect(api.checkout).toHaveBeenCalledTimes(1);
  });
});
