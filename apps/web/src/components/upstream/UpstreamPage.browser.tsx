import "../../index.css";
import { DEFAULT_UNIFIED_SETTINGS, ProjectId, type UpstreamOverview, type UpstreamTopicRow } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { projectSettingsQueryOptions } from "../../lib/projectSettingsQuery";
import { serverConfigQueryOptions } from "../../lib/serverReactQuery";
import { ToastProvider } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { UpstreamPage } from "./UpstreamPage";
import type { UpstreamSearch } from "./upstreamSearch";

const api = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getOverview: vi.fn(),
  listTopics: vi.fn(),
  listTopicIds: vi.fn(),
  getTopic: vi.fn(),
  getTopicFiles: vi.fn(),
  decide: vi.fn(),
  acceptSuggestions: vi.fn(),
  undoDecisions: vi.fn(),
  run: vi.fn(),
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
  // The toast provider reads the active thread from the route.
  useParams: () => null,
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

const inState = (base: UpstreamTopicRow, state: UpstreamTopicRow["state"], scope?: string): UpstreamTopicRow =>
  ({
    ...base,
    state,
    topic: { ...base.topic, status: "port", ...(scope ? { scope } : {}) },
  }) as never;

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

const FACETS = {
  suggestion: { port: 2, skip: 1, watch: 0, equivalent: 0, none: 0 },
  impact: { high: 3, medium: 0, low: 0, none: 0 },
  areas: [{ area: "server", count: 3 }],
};
const topicsPage = (topics: ReadonlyArray<UpstreamTopicRow>, total = topics.length) => ({
  revision: "r1",
  status: "ok",
  topics,
  nextCursor: null,
  total,
  facets: FACETS,
});

/** Stands in for the router: the search params live in state and are shown for assertions. */
function Harness(props: { readonly initial: UpstreamSearch }) {
  const [search, setSearch] = useState<UpstreamSearch>(props.initial);
  return (
    <>
      <output data-testid="search">{JSON.stringify(search)}</output>
      <UpstreamPage search={search} onSearchChange={setSearch} />
    </>
  );
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
  api.listTopics.mockResolvedValue(topicsPage(ROWS));
  api.getTopic.mockImplementation(async ({ topicId }: { topicId: string }) => ({
    revision: "r1",
    repository: "https://github.com/pingdotgg/t3code.git",
    row: ROWS.find((entry) => entry.topic.id === topicId),
    members: [],
    related: [],
    history: [],
  }));
  api.getTopicFiles.mockResolvedValue({
    commits: [],
    totalCommits: 0,
    totals: { files: 0, added: 0, deleted: 0, existingInF5: 0 },
  });
  let token = 0;
  // Like the server: a batch that passes a token joins it.
  const decided = async ({ topicIds, undoToken }: { topicIds: string[]; undoToken?: string }) => ({
    revision: "r2",
    updated: topicIds,
    unchanged: [],
    undoToken: undoToken ?? `token-${(token += 1)}`,
  });
  api.decide.mockImplementation(decided);
  api.acceptSuggestions.mockImplementation(decided);
  api.undoDecisions.mockResolvedValue({ revision: "r3", updated: ["pr-1"], unchanged: [], undoToken: null });
});

async function setup(initial: UpstreamSearch = {}, firstTitle = "Topic A") {
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
      <ToastProvider>
        <TooltipProvider>
          <Harness initial={initial} />
        </TooltipProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("checkbox", { name: `Select ${firstTitle}` })).toBeVisible();
}

const focusList = () => (page.getByRole("listbox", { name: "Upstream topics" }).element() as HTMLElement).focus();
const bulkButton = (name: string) =>
  page.getByRole("toolbar", { name: "Bulk actions" }).getByRole("button", { name, exact: true });

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
  api.listTopics.mockResolvedValue(topicsPage([]));
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
  // Enter activates the empty state's button instead of running a list shortcut.
  api.run.mockResolvedValue({ runId: "run" });
  (page.getByRole("button", { name: "Run now" }).last().element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(api.run).toHaveBeenCalledWith({ projectId, kind: "upstream", triage: "llm" }));
});

it("brings rows and counts back when the decision and the refetch both fail", async () => {
  await setup();
  // The connection is gone: the decision fails, and so does the refetch after it.
  api.decide.mockRejectedValue(new Error("offline"));
  api.listTopics.mockRejectedValue(new Error("offline"));
  api.getOverview.mockRejectedValue(new Error("offline"));
  await page.getByRole("checkbox", { name: "Select Topic A" }).click();
  await bulkButton("Watch").click();
  await vi.waitFor(() => expect(api.decide).toHaveBeenCalled());
  await expect.element(page.getByRole("checkbox", { name: "Select Topic A" })).toBeVisible();
  await expect.element(page.getByText("3 topics")).toBeVisible();
});

it("keeps the topics a failed batch did not record, and drops the ones it did", async () => {
  const many = Array.from({ length: 201 }, (_, index) => row(`pr-${index + 100}`, `Many ${index}`));
  api.listTopics.mockResolvedValue(topicsPage(many));
  api.getOverview.mockResolvedValue({ ...overview, counts: { ...overview.counts, inbox: 201 } });
  api.getTopic.mockImplementation(async ({ topicId }: { topicId: string }) => ({
    revision: "r1",
    repository: "https://github.com/pingdotgg/t3code.git",
    row: many.find((entry) => entry.topic.id === topicId),
    members: [],
    related: [],
    history: [],
  }));
  const recordAll = api.decide.getMockImplementation()!;
  api.decide.mockImplementationOnce(recordAll).mockImplementationOnce(() => Promise.reject(new Error("offline")));
  await setup({}, "Many 0");
  api.listTopics.mockRejectedValue(new Error("offline"));
  api.getOverview.mockRejectedValue(new Error("offline"));
  await page.getByRole("checkbox", { name: "Select all loaded topics" }).click();
  await bulkButton("Watch").click();
  await vi.waitFor(() => expect(api.decide).toHaveBeenCalledTimes(2));
  // The 200 recorded topics are gone; the one that failed is back and still selected for a retry.
  await expect.element(page.getByRole("checkbox", { name: "Select Many 200" })).toBeVisible();
  await expect.element(page.getByRole("checkbox", { name: "Select Many 0" })).not.toBeInTheDocument();
  await expect.element(page.getByText("1 selected")).toBeVisible();
});

it("opens a related topic that is not among the loaded rows", async () => {
  const far = row("pr-900", "Far away topic");
  api.getTopic.mockImplementation(async ({ topicId }: { topicId: string }) => ({
    revision: "r1",
    repository: "https://github.com/pingdotgg/t3code.git",
    row: topicId === far.topic.id ? far : ROWS.find((entry) => entry.topic.id === topicId),
    members: [],
    related: topicId === "pr-1" ? [{ id: far.topic.id, title: far.topic.title, state: "inbox" }] : [],
    history: [],
  }));
  await setup({ project: projectId, topic: "pr-1" });
  await page.getByRole("button", { name: /Far away topic/u }).click();
  await expect.element(page.getByRole("heading", { name: "Far away topic" })).toBeVisible();
  await expect.element(page.getByTestId("search")).toHaveTextContent('"topic":"pr-900"');
});

it("keeps list shortcuts working after clicking the select-all checkbox", async () => {
  await setup();
  await page.getByRole("checkbox", { name: "Select all loaded topics" }).click();
  await expect.element(page.getByText("3 selected")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("3 topics")).toBeVisible();
  await page.getByRole("checkbox", { name: "Select all loaded topics" }).click();
  await userEvent.keyboard("w");
  await vi.waitFor(() =>
    expect(api.decide).toHaveBeenCalledWith({ projectId, topicIds: ["pr-1", "pr-2", "pr-3"], decision: { kind: "watch" } }),
  );
});

it("extends the selection, records already-in-f5 and switches lists from the keyboard", async () => {
  await setup({ project: projectId, topic: "pr-1" });
  focusList();
  await userEvent.keyboard("{Shift>}J{/Shift}");
  await expect.element(page.getByText("2 selected")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByText("3 topics")).toBeVisible();
  await userEvent.keyboard("e");
  await vi.waitFor(() =>
    expect(api.decide).toHaveBeenCalledWith({ projectId, topicIds: ["pr-2"], decision: { kind: "equivalent" } }),
  );
  focusList();
  await userEvent.keyboard("]");
  await expect.element(page.getByTestId("search")).toHaveTextContent('"list":"ready"');
  // `[[` is user-event's escape for one `[` key press.
  focusList();
  await userEvent.keyboard("[[");
  await expect.element(page.getByTestId("search")).toHaveTextContent('"list":"inbox"');
  // Inbox is the first list, so `[` wraps to the last one.
  focusList();
  await userEvent.keyboard("[[");
  await expect.element(page.getByTestId("search")).toHaveTextContent('"list":"skipped"');
});

it("saves and clears the scope of a Ready topic without leaving the list", async () => {
  const ready = inState(ROWS[0]!, "ready", "Only the panel");
  api.listTopics.mockResolvedValue(topicsPage([ready]));
  api.getTopic.mockResolvedValue({
    revision: "r1",
    repository: "https://github.com/pingdotgg/t3code.git",
    row: ready,
    members: [],
    related: [],
    history: [],
  });
  await setup({ project: projectId, list: "ready", topic: "pr-1" });
  const scope = page.getByRole("textbox", { name: "Scope note" });
  await scope.fill("Only the API");
  await page.getByRole("button", { name: "Save scope" }).click();
  await vi.waitFor(() =>
    expect(api.decide).toHaveBeenLastCalledWith({
      projectId,
      topicIds: ["pr-1"],
      decision: { kind: "port", scope: "Only the API" },
    }),
  );
  await expect.element(page.getByRole("checkbox", { name: "Select Topic A" })).toBeVisible();
  await scope.fill("");
  await page.getByRole("button", { name: "Save scope" }).click();
  await vi.waitFor(() =>
    expect(api.decide).toHaveBeenLastCalledWith({ projectId, topicIds: ["pr-1"], decision: { kind: "port" } }),
  );
});

it("asks before reopening topics whose port is in progress", async () => {
  api.listTopics.mockResolvedValue(topicsPage([inState(ROWS[0]!, "in-progress"), inState(ROWS[2]!, "in-progress")]));
  await setup({ project: projectId, list: "in-progress" });
  await page.getByRole("checkbox", { name: "Select all loaded topics" }).click();
  await bulkButton("Reopen").click();
  await expect.element(page.getByText("Reopen 2 topics?")).toBeVisible();
  expect(api.decide).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Reopen", exact: true }).last().click();
  await vi.waitFor(() =>
    expect(api.decide).toHaveBeenCalledWith({ projectId, topicIds: ["pr-1", "pr-3"], decision: { kind: "inbox" } }),
  );
});

it("round-trips filters through the search params and shows them as removable chips", async () => {
  await setup();
  await page.getByRole("button", { name: /^Filter/u }).click();
  await page.getByRole("menuitemcheckbox", { name: /^Skip/u }).click();
  await vi.waitFor(() =>
    expect(api.listTopics).toHaveBeenLastCalledWith(
      expect.objectContaining({ list: "inbox", filter: { suggestion: ["skip"] } }),
    ),
  );
  await expect.element(page.getByTestId("search")).toHaveTextContent('"suggestion":["skip"]');
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Remove filter Skip" }).click();
  await expect.element(page.getByTestId("search")).not.toHaveTextContent("suggestion");
  await expect.element(page.getByRole("button", { name: "Remove filter Skip" })).not.toBeInTheDocument();
});

it("filters from the suggestion strip and searches with a debounce", async () => {
  await setup();
  await page.getByRole("group", { name: "Suggestions" }).getByRole("button", { name: /^Port/u }).click();
  await expect.element(page.getByTestId("search")).toHaveTextContent('"suggestion":["port"]');
  await page.getByRole("searchbox", { name: "Search topics" }).fill("terminal");
  await vi.waitFor(() =>
    expect(api.listTopics).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: { query: "terminal", suggestion: ["port"] } }),
    ),
  );
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await expect.element(page.getByTestId("search")).not.toHaveTextContent("suggestion");
  await expect.element(page.getByTestId("search")).not.toHaveTextContent('"q"');
  await expect.element(page.getByRole("searchbox", { name: "Search topics" })).toHaveValue("");
});

const matchingIds = (count: number) => Array.from({ length: count }, (_, index) => `pr-${index + 100}`);
const selectAllMatching = async (total: number) => {
  await page.getByRole("checkbox", { name: "Select all loaded topics" }).click();
  await page.getByRole("button", { name: `Select all ${total} matching` }).click();
};

it("selects every matching topic, asks before a shortcut reaches unseen ones, and decides them all", async () => {
  api.listTopics.mockResolvedValue(topicsPage(ROWS, 250));
  api.listTopicIds.mockResolvedValue({ revision: "r1", topicIds: matchingIds(250), truncated: false });
  await setup();
  await expect.element(page.getByText("250 topics")).toBeVisible();
  await selectAllMatching(250);
  await expect.element(page.getByText("250 selected")).toBeVisible();
  expect(api.listTopicIds).toHaveBeenCalledWith({ projectId, list: "inbox" });
  focusList();
  await userEvent.keyboard("w");
  await expect.element(page.getByText("Watch 250 topics?")).toBeVisible();
  await expect.element(page.getByText(/^250 topics are not loaded/u)).toBeVisible();
  expect(api.decide).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Watch", exact: true }).last().click();
  await vi.waitFor(() => expect(api.decide).toHaveBeenCalledTimes(2));
  expect(api.decide.mock.calls.map(([input]) => input.topicIds.length)).toEqual([200, 50]);
  // Every selected topic got its decision, so nothing stays selected.
  await expect.element(page.getByText("250 topics")).toBeVisible();
});

it("drops a Select all matching answer that arrives after the list changed", async () => {
  let answer: (value: unknown) => void = () => {};
  api.listTopics.mockResolvedValue(topicsPage(ROWS, 250));
  api.listTopicIds.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await setup();
  await selectAllMatching(250);
  focusList();
  await userEvent.keyboard("]");
  await expect.element(page.getByTestId("search")).toHaveTextContent('"list":"ready"');
  answer({ revision: "r1", topicIds: matchingIds(250), truncated: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect.element(page.getByText("250 topics")).toBeVisible();
  await expect.element(page.getByText("250 selected")).not.toBeInTheDocument();
});

it.each(["succeeds", "fails"])(
  "keeps only the unrecorded topics of an all-matching decision selected when the refetch %s",
  async (refetch) => {
    api.listTopics.mockResolvedValue(topicsPage(ROWS, 450));
    api.listTopicIds.mockResolvedValue({ revision: "r1", topicIds: matchingIds(450), truncated: false });
    const recordAll = api.decide.getMockImplementation()!;
    api.decide
      .mockImplementationOnce(recordAll)
      .mockImplementationOnce(recordAll)
      .mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await setup();
    await selectAllMatching(450);
    // The recorded batches move the ledger revision; a successful refetch must not drop the retry set.
    if (refetch === "succeeds") api.listTopics.mockResolvedValue({ ...topicsPage(ROWS, 50), revision: "r2" });
    else api.listTopics.mockRejectedValue(new Error("offline"));
    await bulkButton("Watch").click();
    await page.getByRole("button", { name: "Watch", exact: true }).last().click();
    await vi.waitFor(() => expect(api.decide).toHaveBeenCalledTimes(3));
    await expect.element(page.getByText("50 selected")).toBeVisible();
    await expect.element(page.getByText("Topics that were not recorded stay selected")).toBeVisible();
    await bulkButton("Watch").click();
    await page.getByRole("button", { name: "Watch", exact: true }).last().click();
    await vi.waitFor(() => expect(api.decide).toHaveBeenCalledTimes(4));
    expect(api.decide.mock.calls[3]![0].topicIds).toEqual(matchingIds(450).slice(400));
  },
);

it("counts unloaded topics of an all-matching selection when reopening In progress topics", async () => {
  const loaded = [inState(ROWS[0]!, "in-progress"), inState(ROWS[2]!, "in-progress")];
  api.listTopics.mockResolvedValue(topicsPage(loaded, 5));
  api.listTopicIds.mockResolvedValue({
    revision: "r1",
    topicIds: ["pr-1", "pr-3", ...matchingIds(3)],
    truncated: false,
  });
  await setup({ project: projectId, list: "in-progress" });
  await selectAllMatching(5);
  await bulkButton("Reopen").click();
  await expect.element(page.getByText("Reopen 5 topics?")).toBeVisible();
  await expect.element(page.getByText(/^5 have port threads in progress/u)).toBeVisible();
  await expect.element(page.getByText(/3 topics are not loaded/u)).toBeVisible();
});

it("undoes a decision from its toast, and the newest one with z", async () => {
  await setup();
  await page.getByRole("checkbox", { name: "Select Topic C" }).click();
  await page.getByRole("toolbar", { name: "Bulk actions" }).getByRole("button", { name: "Watch", exact: true }).click();
  await expect.element(page.getByText("Watching 1 topic")).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await vi.waitFor(() => expect(api.undoDecisions).toHaveBeenCalledWith({ projectId, undoToken: "token-1" }));
  await expect.element(page.getByText("Undid the decision for 1 topic")).toBeVisible();

  await page.getByRole("checkbox", { name: "Select Topic A" }).click();
  await page.getByRole("toolbar", { name: "Bulk actions" }).getByRole("button", { name: "Watch", exact: true }).click();
  await vi.waitFor(() => expect(api.decide).toHaveBeenCalledTimes(2));
  await page.getByRole("listbox").first().click();
  await userEvent.keyboard("z");
  await vi.waitFor(() => expect(api.undoDecisions).toHaveBeenLastCalledWith({ projectId, undoToken: "token-2" }));
  // Each token works once: a second z has nothing left to undo.
  await userEvent.keyboard("z");
  await expect.element(page.getByText("Nothing to undo")).toBeVisible();
  expect(api.undoDecisions).toHaveBeenCalledTimes(2);
});

it("keeps one undo for a whole bulk action, and offers it again when the undo fails", async () => {
  api.listTopics.mockResolvedValue(topicsPage(ROWS, 450));
  api.listTopicIds.mockResolvedValue({ revision: "r1", topicIds: matchingIds(450), truncated: false });
  await setup();
  await selectAllMatching(450);
  await bulkButton("Watch").click();
  await page.getByRole("button", { name: "Watch", exact: true }).last().click();
  await vi.waitFor(() => expect(api.decide).toHaveBeenCalledTimes(3));
  // Later batches join the first batch's token.
  expect(api.decide.mock.calls.map(([input]) => input.undoToken)).toEqual([undefined, "token-1", "token-1"]);
  await expect.element(page.getByText("Watching 450 topics")).toBeVisible();

  api.undoDecisions.mockRejectedValueOnce(new Error("The repository is busy"));
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(page.getByText("Could not undo")).toBeVisible();
  // The entry is back, so Undo works once the repository is free (the first toast may still be closing).
  api.undoDecisions.mockResolvedValueOnce({ revision: "r3", updated: matchingIds(440), unchanged: matchingIds(450).slice(440), undoToken: null });
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await vi.waitFor(() => expect(api.undoDecisions).toHaveBeenCalledTimes(2));
  expect(api.undoDecisions.mock.calls.map(([input]) => input.undoToken)).toEqual(["token-1", "token-1"]);
  await expect.element(page.getByText("Undid the decision for 440 topics")).toBeVisible();
  await expect.element(page.getByText("10 topics changed since and were left as they are")).toBeVisible();
});

it("shows the topic's changed files and history in the detail pane", async () => {
  const sha = "a".repeat(40);
  api.getTopicFiles.mockResolvedValue({
    commits: [
      {
        sha,
        available: true,
        files: [
          { path: "apps/web/src/app.tsx", added: 4, deleted: 1, existsInF5: true, diffAnchor: "diff-app" },
          { path: "apps/mobile/app.tsx", added: 1, deleted: 0, existsInF5: false, diffAnchor: "diff-mobile" },
        ],
        totalFiles: 2,
        truncated: false,
      },
    ],
    totalCommits: 60,
    totals: { files: 2, added: 5, deleted: 1, existingInF5: 1 },
  });
  api.getTopic.mockImplementation(async ({ topicId }: { topicId: string }) => ({
    revision: "r1",
    repository: "https://github.com/pingdotgg/t3code.git",
    row: ROWS.find((entry) => entry.topic.id === topicId),
    members: [],
    related: [],
    history: [
      { at: "2026-10-26T10:00:00Z", kind: "created", epoch: 1, publication: "published" },
      {
        at: "2026-10-26T11:00:00Z",
        kind: "decided",
        epoch: 1,
        publication: "pending",
        status: "skip",
        decidedBy: "user",
        reasonKey: "docs",
      },
    ],
  }));
  await setup({ project: projectId, topic: "pr-1" });
  const files = page.getByRole("region", { name: "Files changed" });
  await expect.element(files.getByText("2 files · +5 −1 · 1 exist in f5")).toBeVisible();
  await expect.element(files.getByRole("link", { name: "apps/web/src/app.tsx" })).toHaveAttribute(
    "href",
    `https://github.com/pingdotgg/t3code/commit/${sha}#diff-app`,
  );
  await expect.element(files.getByText("not in f5")).toBeVisible();
  await expect.element(files.getByText("Only the first 1 of 60 commits are listed.")).toBeVisible();
  await page.getByRole("button", { name: "History (2)" }).click();
  const history = page.getByRole("list", { name: "Topic history" });
  await expect.element(history.getByText("Skipped")).toBeVisible();
  await expect.element(history.getByText("Docs only")).toBeVisible();
  await expect.element(history.getByText("Unpublished")).toBeVisible();
});
