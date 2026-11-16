import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PullRequestKey,
  type NativeApi,
  type PrHubCheckLog,
  type PrHubCheckRun,
  type PrHubChecksResult,
  type TrackedPullRequest,
} from "@t3tools/contracts";
import { GITHUB_FORGE_CAPABILITIES } from "@t3tools/shared/forgeCapabilities";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { setPrHubAccount } from "../../lib/prHubAccount";
import { PrChecksTab, type PrChecksTabProps } from "./PrChecksTab";

const api = vi.hoisted(() => ({ getChecks: vi.fn(), getCheckLog: vi.fn() }));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ prHub: api }) as unknown as NativeApi,
}));

const KEY = PullRequestKey.makeUnsafe("github:github.com/octo/repo#1");

const pr = (overrides: Partial<TrackedPullRequest> = {}) =>
  ({
    key: KEY,
    provider: "github",
    forgeCapabilities: GITHUB_FORGE_CAPABILITIES,
    state: "open",
    roles: ["author"],
    ignoredAt: null,
    repositoryArchived: false,
    headRefOid: "head",
    checkRollup: "failure",
    ...overrides,
  }) as TrackedPullRequest;

const check = (
  id: string,
  name: string,
  status: PrHubCheckRun["status"],
  overrides: Partial<PrHubCheckRun> = {},
): PrHubCheckRun => ({
  id,
  name,
  status,
  description: null,
  url: `https://github.com/octo/repo/actions/runs/9/job/${id}`,
  workflow: "CI",
  workflowRunId: "9",
  startedAt: "2026-01-02T00:00:00.000Z",
  completedAt: status === "pending" ? null : "2026-01-02T00:03:12.000Z",
  logAvailable: status !== "pending",
  ...overrides,
});

const result = (checks: PrHubCheckRun[], overrides: Partial<PrHubChecksResult> = {}) => ({
  headOid: "head",
  truncated: false,
  refreshedAt: "2026-01-02T00:00:00.000Z",
  checks,
  ...overrides,
});

const log = (checkId: string, overrides: Partial<PrHubCheckLog> = {}): PrHubCheckLog => ({
  checkId,
  excerpt: `step output of ${checkId}\n##[error]Process completed with exit code 1.`,
  startLine: 521,
  totalLines: 1000,
  errorLine: 522,
  truncated: true,
  ...overrides,
});

const DEFAULT_CHECKS = [
  check("503", "lint", "success"),
  check("501", "build", "failure", { required: true }),
  check("502", "e2e", "pending"),
  check("504", "deploy", "failure", { workflow: "Release", workflowRunId: "10" }),
  check("status:ci/external", "ci/external", "failure", {
    workflow: null,
    workflowRunId: null,
    logAvailable: false,
    description: "Build failed",
    url: "https://ci.example/1",
  }),
  check("505", "docs", "skipped"),
];

let active: Awaited<ReturnType<typeof render>> | undefined;
async function mount(props: Partial<PrChecksTabProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  active = await render(
    <QueryClientProvider client={client}>
      <PrChecksTab pr={pr()} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setPrHubAccount({ host: "github.com", viewerId: 1, generation: "gen-1" });
  api.getChecks.mockResolvedValue(result(DEFAULT_CHECKS));
  api.getCheckLog.mockImplementation(({ checkId }: { checkId: string }) =>
    Promise.resolve(log(checkId)),
  );
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

it("lists what failed first, by workflow, and folds what passed", async () => {
  await mount();
  const panel = page.getByRole("tabpanel", { name: "Checks" });
  await expect.element(panel).toHaveTextContent("3 failed, 1 running, 1 passed, 1 skipped");
  expect(api.getChecks).toHaveBeenCalledWith({ key: KEY, accountGeneration: "gen-1" });

  const sections = panel.getByRole("heading", { level: 3 }).all();
  expect(sections.map((heading) => heading.element().textContent)).toEqual([
    "Failed3",
    "Running1",
    "Passed1",
    "Skipped1",
  ]);
  // Failed checks are split by workflow, with the ones that belong to none last.
  await expect.element(panel.getByRole("list", { name: "Failed checks of CI" })).toBeVisible();
  await expect.element(panel.getByRole("list", { name: "Failed checks of Release" })).toBeVisible();
  const other = panel.getByRole("list", { name: "Failed checks", exact: true });
  await expect.element(other).toHaveTextContent("ci/external");
  await expect.element(other).toHaveTextContent("Build failed");
  await expect
    .element(panel.getByRole("list", { name: "Failed checks of CI" }))
    .toHaveTextContent("Required");
  await expect
    .element(panel.getByRole("list", { name: "Failed checks of CI" }))
    .toHaveTextContent("3m 12s");

  expect(panel.getByText("lint", { exact: true }).query()).toBeNull();
  await panel.getByRole("button", { name: /Passed/ }).click();
  await expect.element(panel.getByText("lint", { exact: true })).toBeVisible();
});

it("shows the log of each failed job around its error, without asking", async () => {
  await mount();
  const panel = page.getByRole("tabpanel", { name: "Checks" });
  const buildLog = panel.getByRole("group", { name: "Log of build" });
  await expect.element(buildLog).toHaveTextContent("step output of 501");
  await expect.element(buildLog).toHaveTextContent("##[error]Process completed with exit code 1.");
  await expect.element(panel.getByText("Lines 521–522 of 1000").first()).toBeVisible();
  await expect
    .element(panel.getByRole("group", { name: "Log of deploy" }))
    .toHaveTextContent("step output of 504");
  // Only failed jobs that have a log are read: not the passed one, not the outside status.
  expect(api.getCheckLog.mock.calls.map(([input]) => input.checkId).toSorted()).toEqual([
    "501",
    "504",
  ]);
  expect(api.getCheckLog).toHaveBeenCalledWith({
    key: KEY,
    accountGeneration: "gen-1",
    checkId: "501",
  });
  expect(panel.getByRole("button", { name: "Show log of ci/external" }).query()).toBeNull();

  await panel.getByRole("button", { name: "Hide log of build" }).click();
  expect(panel.getByRole("group", { name: "Log of build" }).query()).toBeNull();
  await panel.getByRole("button", { name: "Show log of build" }).click();
  await expect.element(panel.getByRole("group", { name: "Log of build" })).toBeVisible();
});

it("copies the excerpt and links to the full log", async () => {
  const written: string[] = [];
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (value) => {
    written.push(value);
  });
  api.getChecks.mockResolvedValue(result([check("501", "build", "failure")]));
  await mount();
  const panel = page.getByRole("tabpanel", { name: "Checks" });
  await panel.getByRole("button", { name: "Copy" }).click();
  await expect
    .poll(() => written)
    .toEqual(["step output of 501\n##[error]Process completed with exit code 1."]);
  await expect
    .element(panel.getByRole("link", { name: "Open full log" }))
    .toHaveAttribute("href", "https://github.com/octo/repo/actions/runs/9/job/501");
});

it("opens only the first three logs and loads another when asked", async () => {
  api.getChecks.mockResolvedValue(
    result(["1", "2", "3", "4"].map((id) => check(`60${id}`, `job ${id}`, "failure"))),
  );
  await mount();
  const panel = page.getByRole("tabpanel", { name: "Checks" });
  await expect.element(panel.getByRole("group", { name: "Log of job 3" })).toBeVisible();
  expect(api.getCheckLog).toHaveBeenCalledTimes(3);
  await panel.getByRole("button", { name: "Show log of job 4" }).click();
  await expect
    .element(panel.getByRole("group", { name: "Log of job 4" }))
    .toHaveTextContent("step output of 604");
  expect(api.getCheckLog).toHaveBeenCalledTimes(4);
});

it("says why a log is missing and retries one that failed to load", async () => {
  api.getChecks.mockResolvedValue(
    result([check("501", "build", "failure"), check("504", "deploy", "failure")]),
  );
  const unavailable = (checkId: string, reason: PrHubCheckLog["unavailable"]) =>
    log(checkId, { excerpt: null, unavailable: reason, startLine: 0, totalLines: 0 });
  let buildAttempts = 0;
  api.getCheckLog.mockImplementation(({ checkId }: { checkId: string }) =>
    Promise.resolve(
      checkId === "504"
        ? unavailable("504", "expired")
        : ++buildAttempts === 1
          ? unavailable("501", "failed")
          : log("501"),
    ),
  );
  await mount();
  const panel = page.getByRole("tabpanel", { name: "Checks" });
  await expect
    .element(panel.getByText("The log is no longer available; the forge deletes old logs."))
    .toBeVisible();
  await expect
    .element(panel.getByText("The log could not be loaded. It may be too large to show here."))
    .toBeVisible();
  // An expired log will not come back; a failed read might.
  expect(panel.getByRole("button", { name: "Retry" }).all()).toHaveLength(1);
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect
    .element(panel.getByRole("group", { name: "Log of build" }))
    .toHaveTextContent("step output of 501");
});

it("offers the re-run and the fix only where they apply", async () => {
  const onRerun = vi.fn();
  const onFixCi = vi.fn();
  await mount({ onRerun, onFixCi });
  const panel = page.getByRole("tabpanel", { name: "Checks" });
  await panel.getByRole("button", { name: "Re-run failed jobs" }).click();
  await panel.getByRole("button", { name: "Fix CI with F5" }).click();
  expect(onRerun).toHaveBeenCalledTimes(1);
  expect(onFixCi).toHaveBeenCalledTimes(1);
  await active?.unmount();

  // A reviewer without write access gets neither.
  await mount({
    onRerun,
    onFixCi,
    pr: pr({
      roles: [],
      forgeCapabilities: {
        ...GITHUB_FORGE_CAPABILITIES,
        checks: { logs: true, rerun: false },
        actions: GITHUB_FORGE_CAPABILITIES.actions.filter(
          (action) => action !== "rerun-failed-checks",
        ),
      },
    }),
  });
  await expect.element(page.getByRole("tabpanel", { name: "Checks" })).toHaveTextContent("failed");
  expect(page.getByRole("button", { name: "Re-run failed jobs" }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Fix CI with F5" }).query()).toBeNull();
  await active?.unmount();

  // Nothing failed: nothing to re-run or fix. A failed outside status cannot be re-run.
  api.getChecks.mockResolvedValue(result([check("503", "lint", "success")]));
  await mount({ onRerun, onFixCi });
  await expect
    .element(page.getByRole("tabpanel", { name: "Checks" }))
    .toHaveTextContent("1 passed");
  expect(page.getByRole("button", { name: "Re-run failed jobs" }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Fix CI with F5" }).query()).toBeNull();
  await active?.unmount();

  api.getChecks.mockResolvedValue(
    result([
      check("status:ci/external", "ci/external", "failure", {
        workflow: null,
        workflowRunId: null,
        logAvailable: false,
      }),
    ]),
  );
  await mount({ onRerun, onFixCi });
  await expect.element(page.getByRole("button", { name: "Fix CI with F5" })).toBeVisible();
  expect(page.getByRole("button", { name: "Re-run failed jobs" }).query()).toBeNull();
});

it("asks the forge again on Refresh and reports an incomplete list", async () => {
  api.getChecks.mockResolvedValueOnce(
    result([check("502", "e2e", "pending")], { truncated: true }),
  );
  await mount();
  const panel = page.getByRole("tabpanel", { name: "Checks" });
  await expect.element(panel).toHaveTextContent("1 running");
  await expect.element(panel.getByText("Some checks are not listed")).toBeVisible();

  api.getChecks.mockResolvedValueOnce(result([check("502", "e2e", "success")]));
  await panel.getByRole("button", { name: "Refresh checks" }).click();
  await expect.element(panel).toHaveTextContent("1 passed");
  expect(api.getChecks).toHaveBeenLastCalledWith({
    key: KEY,
    accountGeneration: "gen-1",
    mode: "force",
  });
});

it("shows an empty state and a retry when the checks cannot be read", async () => {
  api.getChecks.mockResolvedValueOnce(result([]));
  await mount();
  await expect
    .element(page.getByRole("tabpanel", { name: "Checks" }))
    .toHaveTextContent("No checks ran on this commit.");
  await active?.unmount();

  api.getChecks.mockRejectedValueOnce(new Error("GitHub checks read failed."));
  await mount();
  await expect.element(page.getByText("GitHub checks read failed.")).toBeVisible();
  api.getChecks.mockResolvedValueOnce(result([check("503", "lint", "success")]));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect
    .element(page.getByRole("tabpanel", { name: "Checks" }))
    .toHaveTextContent("1 passed");
});
