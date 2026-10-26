import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS, ProjectId, type UpstreamOverview, type UpstreamTopicRow } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { TooltipProvider } from "../ui/tooltip";
import { UpstreamPage } from "./UpstreamPage";
import type { UpstreamSearch } from "./upstreamSearch";

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getOverview: vi.fn(),
  listTopics: vi.fn(),
  getTopic: vi.fn(),
  decide: vi.fn(),
  acceptSuggestions: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ upstreamPorts: api, server: { updateSettings: vi.fn() } }),
  readNativeApi: () => ({ upstreamPorts: api }),
}));
// The Start port dialog reads the merged settings.
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => vi.fn(),
}));

const projectId = ProjectId.makeUnsafe("project");

const row = (id: string, title: string, status: "port" | "skip" = "port"): UpstreamTopicRow =>
  ({
    topic: {
      id,
      createdAt: "2026-10-26T10:00:00Z",
      title,
      summary: `${title} summary`,
      upstreamPrs: [Number(id.slice(3))],
      status: "inbox",
      epoch: 1,
      suggestion: {
        status,
        ...(status === "skip" ? { reasonKey: "docs" } : {}),
        reason: "Because",
        userImpact: "high",
        confidence: 0.85,
        areas: ["server"],
        model: "claude",
      },
    },
    state: "inbox",
    commitCount: 1,
    links: [],
    doneBy: null,
  }) as never;

const ROWS = [row("pr-1", "Topic A"), row("pr-2", "Topic B", "skip"), row("pr-3", "Topic C")];

const overview = {
  projectId,
  revision: "r1",
  config: { repository: "https://github.com/pingdotgg/t3code.git", remote: "upstream", branch: "main", ledgerDir: "upstream" },
  diagnostics: [],
  remoteStatus: "ok",
  remoteUrl: "https://github.com/pingdotgg/t3code.git",
  writer: { claimed: true, managedByThisProfile: true, profileId: "me", hostname: null, claimedAt: null },
  activeRun: null,
  lastRun: {
    runId: "run",
    kind: "upstream",
    trigger: "manual",
    triage: "llm",
    status: "succeeded",
    startedAt: "2026-10-26T09:00:00Z",
    finishedAt: "2026-10-26T09:01:00Z",
    failureKind: null,
    targetSha: null,
    commitCount: 3,
    inboxCount: 3,
    autoDecidedCount: 0,
    remainingCount: 0,
    llmCalls: 1,
    errorMessage: null,
  },
  schedule: { mode: "off", hour: 9, weekday: 1 },
  nextRunAt: null,
  occurrence: null,
  publication: {
    branch: "f5/upstream-ledger",
    prNumber: 228,
    prUrl: "https://github.com/x/y/pull/228",
    prState: "open",
    phase: "idle",
    pausedReason: null,
    lastError: null,
    unpublishedOps: 11,
  },
  counts: { inbox: 3, ready: 0, "in-progress": 0, watch: 0, done: 0, skipped: 0 },
  trackedThrough: null,
  legacyRemaining: 0,
  untriagedUpstreamCount: 0,
  ghAvailable: true,
  triageModelAvailable: true,
  policyTruncated: false,
  autoSkipConfidence: 0.85,
  reasonKeys: ["docs"],
  reasonLabels: { docs: "Docs only" },
  upstreamOnlySubsystems: [],
} as unknown as UpstreamOverview;

function Harness(props: { readonly initial: UpstreamSearch }) {
  const [search, setSearch] = useState<UpstreamSearch>(props.initial);
  return <UpstreamPage search={search} onSearchChange={setSearch} />;
}

let active: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

beforeEach(() => {
  vi.clearAllMocks();
  api.listProjects.mockResolvedValue({
    projects: [{ projectId, title: "f5", repository: "x", inboxCount: 3, managedByThisProfile: true }],
  });
  api.getOverview.mockResolvedValue(overview);
  api.listTopics.mockResolvedValue({ revision: "r1", status: "ok", topics: ROWS, nextCursor: null });
  api.getTopic.mockImplementation(async ({ topicId }: { topicId: string }) => ({
    revision: "r1",
    repository: "https://github.com/pingdotgg/t3code.git",
    row: ROWS.find((entry) => entry.topic.id === topicId),
    members: [],
    related: [],
  }));
  api.decide.mockImplementation(async ({ topicIds }: { topicIds: string[] }) => ({
    revision: "r2",
    updated: topicIds,
    unchanged: [],
  }));
  api.acceptSuggestions.mockImplementation(async ({ topicIds }: { topicIds: string[] }) => ({
    revision: "r2",
    updated: topicIds,
    unchanged: [],
  }));
});

async function setup(initial: UpstreamSearch = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData<unknown>(serverConfigQueryOptions().queryKey, {
    providers: [],
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  });
  client.setQueryData<unknown>(projectSettingsQueryOptions(projectId).queryKey, {
    settings: DEFAULT_UNIFIED_SETTINGS,
    overrides: {},
  });
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Harness initial={initial} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("checkbox", { name: "Select Topic A" })).toBeVisible();
}

it("shows the bulk bar for a selection and applies its action to the selected rows", async () => {
  await setup();
  await expect.element(page.getByText("3 topics")).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Topic A" }).click();
  await page.getByRole("checkbox", { name: "Select Topic C" }).click();
  await expect.element(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("toolbar", { name: "Bulk actions" }).getByRole("button", { name: "Watch", exact: true }).click();
  await vi.waitFor(() =>
    expect(api.decide).toHaveBeenCalledWith({ projectId, topicIds: ["pr-1", "pr-3"], decision: { kind: "watch" } }),
  );
});

it("selects a range with Shift-click", async () => {
  await setup();
  await page.getByRole("checkbox", { name: "Select Topic A" }).click();
  await page.getByRole("checkbox", { name: "Select Topic C" }).click({ modifiers: ["Shift"] });
  await expect.element(page.getByText("3 selected")).toBeVisible();
  await page.getByRole("button", { name: "Clear selection" }).first().click();
  await expect.element(page.getByText("3 topics")).toBeVisible();
});

it("accepts the suggestion from the detail pane and removes the row before the server answers", async () => {
  // The server never answers, so only the optimistic update can remove the row.
  api.acceptSuggestions.mockReturnValue(new Promise(() => {}));
  await setup({ project: projectId, topic: "pr-1" });
  await page.getByRole("button", { name: "Accept: Port" }).click();
  await vi.waitFor(() => expect(api.acceptSuggestions).toHaveBeenCalledWith({ projectId, topicIds: ["pr-1"] }));
  await expect.element(page.getByRole("checkbox", { name: "Select Topic A" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Topic B" })).toBeVisible();
});

it("renders the run and ledger state in header popovers", async () => {
  await setup();
  await page.getByRole("button", { name: /Synced/u }).click();
  await expect.element(page.getByText("LLM calls")).toBeVisible();
  await page.getByRole("button", { name: "#228 · 11 unpublished" }).click();
  await expect.element(page.getByText("Ledger pull request", { exact: true })).toBeVisible();
});

it("shows Inbox zero when nothing is left to triage", async () => {
  api.listTopics.mockResolvedValue({ revision: "r1", status: "ok", topics: [], nextCursor: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData<unknown>(serverConfigQueryOptions().queryKey, {
    providers: [],
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  });
  active = await render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Harness initial={{}} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByText("Inbox zero")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Run now" }).first()).toBeVisible();
});
