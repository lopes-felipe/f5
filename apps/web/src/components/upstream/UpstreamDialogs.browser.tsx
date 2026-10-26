import "../../index.css";
import type { ModelSelection, UpstreamOverview } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { StartPortDialog, type ModelOption } from "./UpstreamDialogs";

const option = (slug: string): ModelOption => ({
  key: `claude::${slug}`,
  label: `Claude · ${slug}`,
  selection: { instanceId: "claude", model: slug } as ModelSelection,
});

const overview = { untriagedUpstreamCount: 0 } as UpstreamOverview;

type StartInput = Parameters<Parameters<typeof StartPortDialog>[0]["onStart"]>[0];

/** Rebuilds the model list on every render, as the Upstream page does. */
function Harness(props: { readonly onStart: (input: StartInput) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <StartPortDialog
      open
      topicIds={["pr-1", "pr-2"]}
      models={[option("opus"), option("sonnet")]}
      defaultModel={null}
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
  );
}

it("keeps the choices and request id across parent re-renders and a retry", async () => {
  const onStart = vi.fn<(input: StartInput) => void>();
  const screen = await render(<Harness onStart={onStart} />);
  await screen.getByRole("radio", { name: "One thread per topic" }).click();
  await screen.getByRole("combobox", { name: "Port model" }).selectOptions("claude::sonnet");
  await screen.rerender(<Harness onStart={onStart} />);
  await expect.element(screen.getByRole("radio", { name: "One thread per topic" })).toBeChecked();
  await expect.element(screen.getByRole("combobox", { name: "Port model" })).toHaveValue("claude::sonnet");

  await screen.getByRole("button", { name: "Start port" }).click();
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect.element(screen.getByRole("combobox", { name: "Port model" })).toBeDisabled();
  await screen.getByRole("button", { name: "Retry" }).click();

  expect(onStart).toHaveBeenCalledTimes(2);
  const [first, second] = onStart.mock.calls.map(([input]) => input);
  expect(first).toMatchObject({ grouping: "separately", modelSelection: { model: "sonnet" } });
  expect(second).toEqual(first);
});
