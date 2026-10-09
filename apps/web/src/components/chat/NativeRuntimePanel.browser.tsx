import "../../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  EventId,
  ThreadId,
  type NativeOperationRecord,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { readRuntimeConfiguredPayload } from "@t3tools/shared/orchestrationActivityPayload";
import { NativeRuntimePanel } from "./NativeRuntimePanel";
import { ComposerDock, ComposerDockColumn } from "./composer/ComposerDock";

const mocks = vi.hoisted(() => ({
  list: vi.fn(async (): Promise<readonly NativeOperationRecord[]> => []),
  snapshot: vi.fn(async () => ({ entries: [] })),
  execute: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    nativeOperations: { list: mocks.list, execute: mocks.execute, inspect: mocks.inspect },
    agents: { getSnapshot: mocks.snapshot },
  }),
}));
const at = "2026-10-10T00:00:00.000Z";
function fixture(overrides: Partial<Parameters<typeof NativeRuntimePanel>[0]> = {}) {
  return {
    threadId: ThreadId.makeUnsafe("thread"),
    requestedModel: "requested-model",
    prompt: "",
    activities: [],
    capabilities: {
      generation: 1,
      discovery: "discovered" as const,
      checkedAt: at,
      actions: [
        { action: "nativeReview" as const, supported: true },
        { action: "nativeGoals" as const, supported: true },
      ],
    },
    runtime: readRuntimeConfiguredPayload({ config: { model: "reported-model", effort: "high" } }),
    onSuggestion: vi.fn(),
    onStop: async () => {},
    ...overrides,
  };
}
function warnings(): OrchestrationThreadActivity[] {
  return Array.from({ length: 4 }, (_, index) => ({
    id: EventId.makeUnsafe(`warning-${index}`),
    kind: "runtime.warning",
    tone: "info",
    summary: "Protocol warning",
    turnId: null,
    payload: { message: "This CLI does not support native goals; upgrade to use them." },
    createdAt: at,
  }));
}
describe("NativeRuntimePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue([]);
    document.documentElement.classList.add("dark");
  });
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.classList.remove("dark");
  });

  it("keeps runtime details out of the composer and bounds long dialog content", async () => {
    await page.viewport(1000, 650);
    mocks.list.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        operationId: `operation-${index}`,
        threadId: ThreadId.makeUnsafe("thread"),
        generation: 1,
        command: { kind: "review", target: { type: "uncommittedChanges" } },
        state: "failed",
        error: "A provider request failed. ".repeat(30),
        createdAt: at,
        updatedAt: at,
      })),
    );
    const props = fixture({ activities: warnings() });
    const screen = await render(
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex shrink-0 items-center justify-between border-b">
          <span className="px-4">F5 · Reported model</span>
          <NativeRuntimePanel {...props} />
        </div>
        <div data-composer-dock-host className="relative min-h-0 flex-1">
          <p className="p-6">Conversation remains readable</p>
          <ComposerDock>
            <ComposerDockColumn>
              <form
                data-testid="composer"
                className="h-28 shrink-0 rounded-xl border bg-background p-4"
              >
                Ask for follow-up changes
              </form>
            </ComposerDockColumn>
          </ComposerDock>
        </div>
      </div>,
    );
    try {
      const composer = document.querySelector<HTMLElement>('[data-testid="composer"]')!;
      const before = composer.getBoundingClientRect();
      expect(
        document
          .querySelector('[data-slot="composer-dock"]')
          ?.contains(document.querySelector('[data-slot="native-runtime-controls"]')),
      ).toBe(false);
      expect(mocks.list).toHaveBeenCalled();
      expect(mocks.snapshot).not.toHaveBeenCalled();
      await expect
        .element(page.getByText("requested-model", { exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "Runtime details" }).click();
      await expect.element(page.getByText("reported-model", { exact: true })).toBeVisible();
      await expect.element(page.getByText("requested-model", { exact: true })).toBeVisible();
      await expect
        .element(
          page.getByText("This CLI does not support native goals; upgrade to use them.", {
            exact: true,
          }),
        )
        .toBeVisible();
      await expect.element(page.getByText("Protocol warning", { exact: true })).toBeVisible();
      expect(
        document.querySelector('[aria-label="Provider notices"]')?.querySelectorAll(":scope > div")
          .length,
      ).toBe(1);
      await expect
        .element(page.getByRole("region", { name: "Operation history" }))
        .toBeInTheDocument();
      const popup = document.querySelector<HTMLElement>('[data-slot="dialog-popup"]')!;
      const rect = popup.getBoundingClientRect();
      expect(rect.height).toBeLessThanOrEqual(521);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(650);
      const viewport = popup.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
      expect(composer.getBoundingClientRect().height).toBe(before.height);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("discovers uncertain operations without opening the dialog and drops missing server records", async () => {
    const props = fixture();
    mocks.list.mockResolvedValue([
      {
        operationId: "restored",
        threadId: props.threadId,
        generation: 1,
        state: "indeterminate",
        command: { kind: "compact" },
        createdAt: at,
        updatedAt: at,
      },
    ]);
    const screen = await render(<NativeRuntimePanel {...props} />);
    try {
      await expect
        .element(page.getByRole("button", { name: "Runtime details · pending" }))
        .toBeVisible();
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(page.getByRole("dialog").query()).toBeNull();
      mocks.list.mockResolvedValue([]);
      await screen.rerender(
        <NativeRuntimePanel {...props} capabilities={{ ...props.capabilities!, generation: 2 }} />,
      );
      await expect
        .element(page.getByRole("button", { name: "Runtime details", exact: true }))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("does not overwrite a newly admitted operation with an older poll", async () => {
    let finish!: (records: readonly NativeOperationRecord[]) => void;
    const oldPoll = new Promise<readonly NativeOperationRecord[]>((resolve) => {
      finish = resolve;
    });
    mocks.list.mockReturnValue(oldPoll);
    const props = fixture();
    mocks.execute.mockResolvedValue({
      operationId: "new",
      threadId: props.threadId,
      generation: 1,
      state: "running",
      command: { kind: "review", target: { type: "uncommittedChanges" } },
      createdAt: at,
      updatedAt: at,
    });
    const screen = await render(<NativeRuntimePanel {...props} />);
    try {
      await page.getByRole("button", { name: "Runtime details" }).click();
      await page.getByRole("button", { name: "Review", exact: true }).click();
      await expect.element(page.getByText("review · running", { exact: true })).toBeVisible();
      finish([]);
      await oldPoll;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await expect.element(page.getByText("review · running", { exact: true })).toBeVisible();
    } finally {
      finish([]);
      mocks.list.mockResolvedValue([]);
      await screen.unmount();
    }
  });

  it("keeps runtime details reachable in a narrow pane with a long suggestion and goal", async () => {
    await page.viewport(320, 650);
    const suggestion = {
      ...warnings()[0]!,
      kind: "prompt.suggestion",
      summary: "A long suggested prompt ".repeat(30),
    };
    const goal = {
      ...warnings()[0]!,
      id: EventId.makeUnsafe("goal"),
      kind: "native.metadata",
      payload: { nativeGoal: { status: "running", objective: "A long objective" } },
    };
    const screen = await render(
      <div className="flex w-full overflow-hidden">
        <div className="min-w-0 flex-1" />
        <NativeRuntimePanel {...fixture({ activities: [suggestion, goal] })} />
      </div>,
    );
    try {
      const button = page.getByRole("button", { name: "Runtime details" });
      await expect.element(button).toBeVisible();
      const bounds = button.element().getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(320);
      await button.click();
      await expect.element(page.getByRole("dialog")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps reported runtime information available without native session capabilities", async () => {
    const screen = await render(<NativeRuntimePanel {...fixture({ capabilities: null })} />);
    try {
      await page.getByRole("button", { name: "Runtime details" }).click();
      await expect.element(page.getByText("reported-model", { exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Start goal" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a newer reroute as effective without relabeling it as the original request", async () => {
    const config = {
      ...warnings()[0]!,
      kind: "runtime.configured",
      payload: { config: { model: "A" } },
    };
    const reroute = {
      ...warnings()[1]!,
      kind: "runtime.model-rerouted",
      payload: { fromModel: "A", toModel: "B", reason: "capacity" },
    };
    const screen = await render(
      <NativeRuntimePanel
        {...fixture({
          requestedModel: "B",
          runtime: { model: "A" },
          activities: [config, reroute],
        })}
      />,
    );
    try {
      await page.getByRole("button", { name: "Runtime details" }).click();
      const terms = [...document.querySelectorAll("dt")];
      expect(
        terms.find((term) => term.textContent === "Requested model")?.nextElementSibling
          ?.textContent,
      ).toBe("A");
      expect(
        terms.find((term) => term.textContent === "Effective model")?.nextElementSibling
          ?.textContent,
      ).toBe("B");
    } finally {
      await screen.unmount();
    }
  });

  it("resets private dialog state when switching conversations", async () => {
    const props = fixture();
    const screen = await render(<NativeRuntimePanel {...props} />);
    try {
      await page.getByRole("button", { name: "Runtime details" }).click();
      await page.getByRole("textbox", { name: "Goal objective" }).fill("Thread A private goal");
      await screen.rerender(
        <NativeRuntimePanel {...props} threadId={ThreadId.makeUnsafe("thread-b")} />,
      );
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Runtime details" }).click();
      await expect.element(page.getByRole("textbox", { name: "Goal objective" })).toHaveValue("");
    } finally {
      await screen.unmount();
    }
  });
});
