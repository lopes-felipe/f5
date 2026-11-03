import "../index.css";
import { ThreadId, type AgentTranscriptPage } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { AgentTranscriptPanel } from "./AgentTranscriptPanel";
import { useAgentTranscriptStore } from "../lib/agentTranscriptStore";

const mocks = vi.hoisted(() => ({ read: vi.fn(), navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ agents: { readTranscript: mocks.read } }),
}));
vi.mock("../wsConnectionState", () => ({ useWsConnectionState: () => ({ phase: "connected" }) }));
vi.mock("../lib/agentsReactQuery", () => ({
  agentsSnapshotQueryOptions: () => ({
    queryKey: ["snapshot"],
    queryFn: async () => ({ entries: [] }),
    staleTime: Infinity,
  }),
}));
vi.mock("./ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

const empty: AgentTranscriptPage = {
  availability: "ok",
  items: [],
  nextCursor: null,
  earlierCursor: null,
  tailCursor: "tail",
  pendingTail: false,
  reset: false,
};
const props = {
  threadId: ThreadId.makeUnsafe("parent"),
  nativeWorkItemId: "agent",
  workItemIds: ["agent"],
  title: "Explore",
  visible: true,
};
async function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <div className="h-[600px] w-[500px]">
        <AgentTranscriptPanel {...props} />
      </div>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  useAgentTranscriptStore.setState({ entries: {}, order: [] });
  mocks.read.mockReset();
});
describe("AgentTranscriptPanel", () => {
  it("keeps cached rows across tab switches and resumes at the tail", async () => {
    mocks.read.mockResolvedValue({
      ...empty,
      items: [
        {
          id: "cached",
          kind: "message",
          role: "assistant",
          text: "Cached transcript",
          createdAt: null,
          truncated: false,
        },
      ],
    });
    const first = await mount();
    await expect.element(page.getByText("Cached transcript")).toBeVisible();
    await first.unmount();
    const second = await mount();
    try {
      await expect.element(page.getByText("Cached transcript")).toBeVisible();
      await expect.poll(() => mocks.read.mock.calls.length).toBe(2);
      expect(mocks.read.mock.calls[0]?.[0].anchor).toBe("latest");
      expect(mocks.read.mock.calls[1]?.[0].cursor).toBe("tail");
    } finally {
      await second.unmount();
    }
  });
  it("tails a live agent and drains when its snapshot settles", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const row = {
      workItemId: "agent",
      status: "running",
      classification: "working",
      active: true,
      provider: "claudeAgent",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    client.setQueryData(["snapshot"], { entries: [row] });
    mocks.read
      .mockResolvedValueOnce({
        ...empty,
        items: [
          {
            id: "first",
            kind: "message",
            role: "assistant",
            text: "Live transcript",
            createdAt: null,
            truncated: false,
          },
        ],
      })
      .mockResolvedValue({
        ...empty,
        items: [
          {
            id: "final",
            kind: "message",
            role: "assistant",
            text: "Settled transcript",
            createdAt: null,
            truncated: false,
          },
        ],
      });
    const screen = await mount(client);
    try {
      await expect.element(page.getByText("Live transcript")).toBeVisible();
      client.setQueryData(["snapshot"], {
        entries: [{ ...row, active: false, status: "completed" }],
      });
      await expect.element(page.getByText("Settled transcript")).toBeVisible();
      expect(mocks.read.mock.calls.slice(1).every((call) => call[0].cursor === "tail")).toBe(true);
    } finally {
      await screen.unmount();
    }
  });
  it("renders readable rows, folds results and loads earlier history", async () => {
    mocks.read
      .mockResolvedValueOnce({
        ...empty,
        earlierCursor: "before",
        items: [
          {
            id: "u",
            createdAt: null,
            kind: "message",
            role: "user",
            text: "Find the bug",
            truncated: false,
          },
          {
            id: "a",
            createdAt: null,
            kind: "message",
            role: "assistant",
            text: "Found the reader",
            truncated: false,
          },
          {
            id: "t",
            createdAt: null,
            kind: "tool-call",
            toolCallId: "tool",
            toolName: "Read",
            itemType: "dynamic_tool_call",
            title: "Read file",
            detail: "src/main.ts",
            status: "running",
            output: "",
            outputTruncated: false,
          },
          {
            id: "r",
            createdAt: null,
            kind: "tool-result",
            toolCallId: "tool",
            isError: false,
            output: "file contents",
            outputTruncated: false,
          },
          { id: "n", createdAt: null, kind: "notice", text: "Conversation compacted" },
        ],
      })
      .mockResolvedValue({
        ...empty,
        items: [
          {
            id: "early",
            createdAt: null,
            kind: "message",
            role: "user",
            text: "Earlier instructions",
            truncated: false,
          },
        ],
      });
    const screen = await mount();
    try {
      await expect.element(page.getByText("Found the reader")).toBeVisible();
      await expect.element(page.getByText("Read file · completed")).toBeVisible();
      await page.getByRole("button", { name: "Load earlier" }).click();
      await expect.poll(() => mocks.read.mock.calls.length).toBe(2);
      expect(mocks.read.mock.calls[1]?.[0].cursor).toBe("before");
    } finally {
      await screen.unmount();
    }
  });
  it.each([
    "not-started",
    "not-found",
    "identity-unavailable",
    "unsupported-provider",
    "session-not-running",
  ] as const)("shows availability reason %s", async (reason) => {
    mocks.read.mockResolvedValue({ ...empty, availability: "unavailable", reason });
    const screen = await mount();
    try {
      await expect
        .poll(() => useAgentTranscriptStore.getState().entries["parent\u0000agent"]?.reason)
        .toBe(reason);
      expect(document.querySelector('[aria-label="Agent transcript"]')?.textContent).not.toContain(
        "Loading transcript",
      );
    } finally {
      await screen.unmount();
    }
  });
});
