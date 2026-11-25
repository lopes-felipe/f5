import "../../index.css";

import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";

const PROVIDER = ProviderDriverKind.make("opencode");
const MODEL = "test-model";

function modelsWith(
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<ServerProviderModel> {
  return [
    {
      slug: MODEL,
      name: "Test Model",
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [...optionDescriptors] }),
    },
  ];
}

const KNOWN_EFFORT: ProviderOptionDescriptor = {
  id: "variant",
  label: "Variant",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
};

const FAST_MODE: ProviderOptionDescriptor = { id: "fastMode", label: "Fast Mode", type: "boolean" };

/** Holds selections locally, like a settings form would. */
function PickerHarness(props: {
  models: ReadonlyArray<ServerProviderModel>;
  tintTrigger?: boolean;
}) {
  const [options, setOptions] = useState<ReadonlyArray<ProviderOptionSelection> | undefined>();
  return (
    <TraitsPicker
      provider={PROVIDER}
      models={props.models}
      model={MODEL}
      modelOptions={options}
      onModelOptionsChange={setOptions}
      {...(props.tintTrigger ? { tintTrigger: true } : {})}
    />
  );
}

describe("TraitsPicker", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });

  it("keeps the plain list for an effort scale with an unknown level", async () => {
    mounted = await render(
      <PickerHarness
        models={modelsWith([
          {
            id: "variant",
            label: "Variant",
            type: "select",
            options: [
              { id: "minimal", label: "Minimal" },
              { id: "low", label: "Low", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ])}
      />,
    );

    await page.getByRole("button").click();
    await vi.waitFor(() => {
      expect(
        page
          .getByRole("menuitemradio")
          .elements()
          .map((item) => item.textContent),
      ).toEqual(["Minimal", "Low (default)", "High"]);
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Variant");
    expect(text).not.toContain("Reasoning effort");
    expect(document.querySelectorAll("[data-effort-filled]")).toHaveLength(0);
  });

  it("tints the trigger only when asked, as the composer does", async () => {
    mounted = await render(<PickerHarness models={modelsWith([KNOWN_EFFORT])} />);
    const trigger = page.getByRole("button");
    await expect.element(trigger).toHaveTextContent("High");
    // The settings usage stays neutral.
    expect(trigger.element().hasAttribute("data-effort-level")).toBe(false);
    expect(trigger.element().className).not.toContain("bg-effort-");

    await mounted.unmount();
    mounted = await render(<PickerHarness models={modelsWith([KNOWN_EFFORT])} tintTrigger />);
    await expect.element(page.getByRole("button")).toHaveAttribute("data-effort-level", "high");
    expect(page.getByRole("button").element().className).toContain("bg-effort-high/10");
  });

  it("toggles Fast mode inside the traits menu without closing it", async () => {
    const onModelOptionsChange = vi.fn();
    const models = modelsWith([KNOWN_EFFORT, FAST_MODE]);
    mounted = await render(
      <TraitsPicker
        provider={PROVIDER}
        models={models}
        model={MODEL}
        onModelOptionsChange={onModelOptionsChange}
      />,
    );

    await page.getByRole("button").click();
    const fastMode = page.getByRole("menuitemcheckbox", { name: "Fast Mode" });
    await expect.element(fastMode).toHaveAttribute("aria-checked", "false");
    await fastMode.click();

    await vi.waitFor(() => {
      expect(onModelOptionsChange).toHaveBeenLastCalledWith(
        expect.arrayContaining([{ id: "fastMode", value: true }]),
      );
    });
    // Still open: the switch row and the effort rows remain rendered.
    expect(fastMode.element().isConnected).toBe(true);
    expect(document.querySelectorAll('[role="menuitemradio"][data-effort-level]')).toHaveLength(2);
  });
});
