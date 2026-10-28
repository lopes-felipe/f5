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
  useSettings: () => DEFAULT_UNIFIED_SETTINGS,
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
  await page.getByRole("button", { name: /Claude Sonnet 4.6/ }).click();
  await page.getByText("Claude Opus 4.6", { exact: true }).click();
  await active.rerender(harness);
  await expect.element(page.getByRole("radio", { name: "One thread per topic" })).toBeChecked();
  await expect.element(page.getByRole("button", { name: /Claude Opus 4.6/ })).toBeInTheDocument();

  await page.getByRole("button", { name: "Start port" }).click();
  await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: /Claude Opus 4.6/ })).toBeDisabled();
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
