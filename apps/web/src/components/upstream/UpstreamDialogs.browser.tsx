import "../../index.css";
import {
  DEFAULT_UNIFIED_SETTINGS,
  defaultInstanceIdForDriver,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type UpstreamOverview,
  type UpstreamPortReviewSettings,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { createTestServerProvider } from "../../testServerProvider";
import { TooltipProvider } from "../ui/tooltip";
import { StartPortDialog } from "./UpstreamDialogs";
import { getModelPreferences } from "../../modelPreferencesStore";
import { readAppSettingsSnapshot } from "../../appSettings";

const api = vi.hoisted(() => ({
  previewPortGroups: vi.fn(async (input: { target: { topicIds: string[] }; grouping: string; batchSize: number }) => {
    const count = input.target.topicIds.length;
    return {
      topicCount: count,
      threadCount:
        input.grouping === "separately" ? count : input.grouping === "batched" ? Math.ceil(count / input.batchSize) : 1,
      fileLinkedThreads: 0,
      filesUnknown: 0,
      queueable: count,
      skipped: [],
    };
  }),
}));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ upstreamPorts: api }) }));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, ...readAppSettingsSnapshot() }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

const CLAUDE_ID = defaultInstanceIdForDriver(ProviderDriverKind.make("claudeAgent"));
const model = (slug: string, name: string) => ({
  slug,
  name,
  capabilities: createModelCapabilities({ optionDescriptors: [] }),
  isCustom: false,
});
const claude = (): ServerProvider =>
  createTestServerProvider("claudeAgent", {
    models: [model("claude-sonnet-4-6", "Claude Sonnet 4.6"), model("claude-opus-4-6", "Claude Opus 4.6")],
  });
const sonnet = { instanceId: CLAUDE_ID, model: "claude-sonnet-4-6" } as ModelSelection;

const overview = { untriagedUpstreamCount: 0, portQueue: { concurrency: 5 } } as UpstreamOverview;

type StartInput = Parameters<Parameters<typeof StartPortDialog>[0]["onStart"]>[0];

/** Rebuilds the provider list on every render, as the Upstream page does. */
function Harness(props: {
  readonly savedReview?: UpstreamPortReviewSettings | undefined;
  readonly reviewSettingsLoaded?: boolean;
  readonly providers: () => ReadonlyArray<ServerProvider>;
  readonly savedModel: ModelSelection | null;
  readonly topicIds?: ReadonlyArray<string>;
  readonly onStart: (input: StartInput) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delay={0}>
        <StartPortDialog
          open
          projectId={ProjectId.make("project-1")}
          topicIds={props.topicIds ?? ["pr-1", "pr-2"]}
          providers={props.providers()}
          savedModel={props.savedModel}
          savedReview={props.savedReview}
          reviewSettingsLoaded={props.reviewSettingsLoaded ?? true}
          defaultRuntimeMode="full-access"
          overview={overview}
          busy={busy}
          onClose={() => {}}
          onRunFirst={() => {}}
          onStart={(input) => {
            props.onStart(input);
            // The request is lost: busy flips on and off, re-rendering the parent.
            setBusy(true);
            setTimeout(() => setBusy(false), 0);
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

it("keeps the choices and request id across parent re-renders and a retry", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  const harness = <Harness providers={() => [claude()]} savedModel={sonnet} onStart={onStart} />;
  active = await render(harness);
  await page.getByRole("radio", { name: "One thread per topic" }).click();
  await page.getByRole("group", { name: "Port model", exact: true }).getByRole("button", { name: /Claude Sonnet 4.6/ }).click();
  // The picker row, by its full name: other controls can also show the bare model name.
  await page.getByRole("button", { name: /^Claude Opus 4\.6 Claude · claude-opus-4-6/ }).click();
  await active.rerender(harness);
  await expect.element(page.getByRole("radio", { name: "One thread per topic" })).toBeChecked();
  await expect.element(page.getByRole("group", { name: "Port model", exact: true }).getByRole("button", { name: /Claude Opus 4.6/ })).toBeInTheDocument();

  await page.getByRole("button", { name: "Start port" }).click();
  await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect.element(page.getByRole("group", { name: "Port model", exact: true }).getByRole("button", { name: /Claude Opus 4.6/ })).toBeDisabled();
  await page.getByRole("button", { name: "Retry" }).click();

  expect(onStart).toHaveBeenCalledTimes(2);
  const [first, second] = onStart.mock.calls.map(([input]) => input);
  expect(first).toMatchObject({
    grouping: "separately",
    modelSelection: { instanceId: CLAUDE_ID, model: "claude-opus-4-6" },
    runtimeMode: "full-access",
  });
  expect(second).toEqual(first);
});

it("starts on a ready provider when the saved model's provider is unavailable", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  const saved = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
  } as ModelSelection;
  active = await render(<Harness providers={() => [claude()]} savedModel={saved} onStart={onStart} />);
  await page.getByRole("button", { name: "Start port" }).click();
  expect(onStart.mock.calls[0]?.[0].modelSelection.instanceId).toBe(CLAUDE_ID);
});

it("cannot start without a ready provider", async () => {
  active = await render(<Harness providers={() => []} savedModel={sonnet} onStart={() => {}} />);
  await expect.element(page.getByRole("button", { name: "Start port" })).toBeDisabled();
});

it("waits for delayed settings and providers, then hydrates the remembered opt-out and slots once", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  active = await render(<Harness providers={() => []} savedModel={sonnet}
    reviewSettingsLoaded={false} onStart={onStart} />);
  await expect.element(page.getByRole("button", { name: "Start port" })).toBeDisabled();
  const saved: UpstreamPortReviewSettings = { enabled: false,
    reviewerA: { provider: "claudeAgent", model: "claude-opus-4-6" },
    reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    consolidation: { provider: "claudeAgent", model: "claude-opus-4-6" } };
  await active.rerender(<Harness providers={() => [claude()]} savedModel={sonnet}
    savedReview={saved} reviewSettingsLoaded={false} onStart={onStart} />);
  await expect.element(page.getByRole("button", { name: "Start port" })).toBeDisabled();
  await active.rerender(<Harness providers={() => [claude()]} savedModel={sonnet}
    savedReview={saved} reviewSettingsLoaded onStart={onStart} />);
  const checkbox = page.getByRole("checkbox", { name: /Code review after port/ });
  await expect.element(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect.element(page.getByRole("group", { name: "Reviewer A", exact: true })
    .getByRole("button", { name: /Claude Opus 4.6/ })).toBeInTheDocument();
  await checkbox.click();
  await active.rerender(<Harness providers={() => [claude()]} savedModel={sonnet}
    savedReview={{ ...saved, enabled: true }} reviewSettingsLoaded onStart={onStart} />);
  await expect.element(checkbox).not.toBeChecked();
  await page.getByRole("button", { name: "Start port" }).click();
  expect(onStart.mock.calls[0]![0]).toMatchObject({ review: null, reviewPreference: { enabled: false } });
});

it("defaults review on with three labeled pickers, and remembers clearing it without forgetting models", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  const saved: UpstreamPortReviewSettings = {
    enabled: true,
    reviewerA: { provider: "claudeAgent", model: "claude-opus-4-6" },
    reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    consolidation: { provider: "claudeAgent", model: "claude-opus-4-6" },
  };
  active = await render(<Harness providers={() => [claude()]} savedModel={sonnet} savedReview={saved} onStart={onStart} />);
  const checkbox = page.getByRole("checkbox", { name: /Code review after port/ });
  await expect.element(checkbox).toBeChecked();
  for (const name of ["Reviewer A", "Reviewer B", "Consolidation"])
    await expect.element(page.getByRole("group", { name, exact: true })).toBeInTheDocument();
  await checkbox.click();
  await expect.element(page.getByRole("region", { name: "Review models" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Start port" }).click();
  await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();
  await page.getByRole("button", { name: "Retry" }).click();
  const first = onStart.mock.calls[0]![0];
  expect(first.review).toBeNull();
  expect(first.reviewPreference).toEqual({ ...saved, enabled: false });
  expect(onStart.mock.calls[1]![0]).toEqual(first);
  await active.unmount();
  active = await render(<Harness providers={() => [claude()]} savedModel={sonnet} savedReview={first.reviewPreference} onStart={onStart} />);
  await expect.element(page.getByRole("checkbox", { name: /Code review after port/ })).not.toBeChecked();
});

it("sends each review slot's selection, freezes it for retry, and keeps workflow preferences unchanged", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  const saved: UpstreamPortReviewSettings = {
    enabled: true,
    reviewerA: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    consolidation: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
  };
  const preferences = getModelPreferences();
  active = await render(<Harness providers={() => [claude()]} savedModel={sonnet} savedReview={saved} onStart={onStart} />);
  for (const name of ["Reviewer A", "Consolidation"]) {
    await page.getByRole("group", { name, exact: true }).getByRole("button", { name: /Claude Sonnet 4.6/ }).click();
    await page.getByRole("option", { name: "Claude Opus 4.6", exact: true }).click();
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
  }
  expect(getModelPreferences()).toEqual(preferences);
  await page.getByRole("button", { name: "Start port" }).click();
  await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();
  await active.rerender(<Harness providers={() => [claude()]} savedModel={sonnet} savedReview={{ ...saved, enabled: false }} onStart={onStart} />);
  await page.getByRole("button", { name: "Retry" }).click();
  const first = onStart.mock.calls[0]![0];
  expect(first.review).toMatchObject({
    reviewerA: { provider: "claudeAgent", model: "claude-opus-4-6" },
    reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
    consolidation: { provider: "claudeAgent", model: "claude-opus-4-6" },
  });
  expect(onStart.mock.calls[1]![0]).toEqual(first);
});

it("falls back only the unavailable saved review slot", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  const saved: UpstreamPortReviewSettings = {
    enabled: true,
    reviewerA: { provider: "grok", model: "unavailable" },
    reviewerB: { provider: "claudeAgent", model: "claude-opus-4-6" },
    consolidation: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
  };
  active = await render(<Harness providers={() => [claude()]} savedModel={sonnet} savedReview={saved} onStart={onStart} />);
  await page.getByRole("button", { name: "Start port" }).click();
  expect(onStart.mock.calls[0]![0].review).toMatchObject({
    reviewerA: { provider: "claudeAgent" },
    reviewerB: { provider: "claudeAgent", model: "claude-opus-4-6" },
    consolidation: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
  });
});

it("uses the sole enabled provider for all default review slots", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  active = await render(<Harness providers={() => [claude()]} savedModel={sonnet} onStart={onStart} />);
  await page.getByRole("button", { name: "Start port" }).click();
  const review = onStart.mock.calls[0]![0].review!;
  for (const slot of [review.reviewerA, review.reviewerB, review.consolidation])
    expect(slot.provider).toBe("claudeAgent");
});

it("requires turning off review when only an unsupported review provider is enabled", async () => {
  const grok = createTestServerProvider("grok", { models: [model("grok-code", "Grok Code")] });
  active = await render(<Harness providers={() => [grok]}
    savedModel={{ instanceId: grok.instanceId, model: "grok-code" } as ModelSelection} onStart={() => {}} />);
  await expect.element(page.getByRole("alert")).toHaveTextContent("choose an enabled provider that supports code review");
  await expect.element(page.getByRole("button", { name: "Start port" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /Code review after port/ }).click();
  await expect.element(page.getByRole("button", { name: "Start port" })).toBeEnabled();
});

it("preselects batches and Add to queue above 20 topics", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  active = await render(
    <Harness
      providers={() => [claude()]}
      savedModel={sonnet}
      topicIds={Array.from({ length: 21 }, (_, i) => `pr-${i + 1}`)}
      onStart={onStart}
    />,
  );
  await expect.element(page.getByRole("radio", { name: "Add to queue" })).toBeChecked();
  await expect.element(page.getByLabelText("Topics per batch")).toHaveValue("5");
  await page.getByRole("button", { name: "Add to queue" }).click();
  expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ when: "queue", grouping: "batched", batchSize: 5 }));
});

it("gates Start now using the server's thread preview", async () => {
  active = await render(
    <Harness
      providers={() => [claude()]}
      savedModel={sonnet}
      topicIds={Array.from({ length: 6 }, (_, i) => `pr-${i + 1}`)}
      onStart={() => {}}
    />,
  );
  await page.getByRole("radio", { name: "One thread per topic" }).click();
  await expect.element(page.getByText(/6 topics → 6 threads/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Start port" })).toBeDisabled();
  await page.getByRole("radio", { name: "Add to queue" }).click();
  await expect.element(page.getByRole("button", { name: "Add to queue" })).toBeEnabled();
});
