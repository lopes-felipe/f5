import "../../index.css";

import type { ProviderKind, RuntimeMode } from "@t3tools/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RuntimeModePicker } from "./RuntimeModePicker";

/** Modes whose ladder segment is currently filled, top row first. */
function filledModes() {
  return [...document.querySelectorAll('[data-ladder-filled="true"]')].map((segment) =>
    segment.closest("[data-runtime-mode]")?.getAttribute("data-runtime-mode"),
  );
}

function rowModes() {
  return page
    .getByRole("menuitemradio")
    .elements()
    .map((item) => item.getAttribute("data-runtime-mode"));
}

describe("RuntimeModePicker", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    document.body.innerHTML = "";
  });

  async function mountPicker(props: {
    provider?: ProviderKind;
    value: RuntimeMode;
    onValueChange?: (value: RuntimeMode) => void;
  }) {
    mounted = await render(
      <RuntimeModePicker
        provider={props.provider ?? "claudeAgent"}
        value={props.value}
        onValueChange={props.onValueChange ?? (() => {})}
      />,
    );
  }

  it("ranks modes from most to least autonomous and fills up to the selected one", async () => {
    await mountPicker({ value: "auto-accept-edits" });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(rowModes()).toEqual(["full-access", "auto", "auto-accept-edits", "approval-required"]);
      expect(filledModes()).toEqual(["auto-accept-edits", "approval-required"]);
    });
    expect(
      page
        .getByRole("menuitemradio")
        .elements()
        .map((item) => item.textContent),
    ).toEqual([
      "Full accessNever asks",
      "AutoAI approves",
      "Accept editsAsks for commands",
      "SupervisedAsks for all",
    ]);

    const selected = document.querySelectorAll('[data-ladder-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.closest("[data-runtime-mode]")?.getAttribute("data-runtime-mode")).toBe(
      "auto-accept-edits",
    );
    expect(selected[0]?.className).toContain("forced-colors:bg-[color:Highlight]");

    // Descriptions live in the row tooltips.
    await expect
      .element(page.getByRole("menuitemradio", { name: /Auto AI approves/ }))
      .toHaveAttribute(
        "title",
        "The provider's AI reviewer approves, not F5. It can allow risky commands without asking.",
      );

    // Highlighting a row previews its fill; leaving the rows restores the selection.
    await page.getByRole("menuitemradio", { name: /Full access/ }).hover();
    await vi.waitFor(() => {
      expect(filledModes()).toEqual([
        "full-access",
        "auto",
        "auto-accept-edits",
        "approval-required",
      ]);
    });
    await page.getByRole("button").hover();
    await vi.waitFor(() => {
      expect(filledModes()).toEqual(["auto-accept-edits", "approval-required"]);
    });
  });

  it("previews keyboard navigation without previewing the row focused on open", async () => {
    await mountPicker({ value: "auto-accept-edits" });
    page.getByRole("button").element().focus();
    await userEvent.keyboard("{ArrowDown}");

    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute("data-runtime-mode")).toBe("full-access");
    });
    expect(filledModes()).toEqual(["auto-accept-edits", "approval-required"]);

    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute("data-runtime-mode")).toBe("auto");
      expect(filledModes()).toEqual(["auto", "auto-accept-edits", "approval-required"]);
    });

    await userEvent.keyboard("{ArrowUp}");
    await vi.waitFor(() => {
      expect(filledModes()).toEqual([
        "full-access",
        "auto",
        "auto-accept-edits",
        "approval-required",
      ]);
    });
  });

  it("keeps unsupported modes visible but disabled and unfilled", async () => {
    const onValueChange = vi.fn();
    await mountPicker({ provider: "grok", value: "full-access", onValueChange });
    await page.getByRole("button").click();

    await vi.waitFor(() => {
      expect(rowModes()).toHaveLength(4);
    });
    for (const name of [/^Auto/, /^Accept edits/]) {
      const row = page.getByRole("menuitemradio", { name });
      await expect.element(row).toHaveAttribute("aria-disabled", "true");
      await expect.element(row).toHaveTextContent("Unavailable");
    }
    expect(filledModes()).toEqual(["full-access", "approval-required"]);
    expect(page.getByRole("menuitemradio", { name: /^Auto/ }).element().getAttribute("title")).toBe(
      "Auto review is not available for grok.",
    );

    // A DOM click bypasses the disabled row's pointer-events guard.
    (page.getByRole("menuitemradio", { name: /^Auto/ }).element() as HTMLElement).click();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("reports a new selection once and ignores the current one", async () => {
    const onValueChange = vi.fn();
    await mountPicker({ value: "full-access", onValueChange });
    await page.getByRole("button").click();

    await page.getByRole("menuitemradio", { name: /Full access/ }).click();
    expect(onValueChange).not.toHaveBeenCalled();

    // The menu stays open after a choice.
    await page.getByRole("menuitemradio", { name: /Supervised/ }).click();
    await vi.waitFor(() => {
      expect(onValueChange).toHaveBeenCalledTimes(1);
    });
    expect(onValueChange).toHaveBeenCalledWith("approval-required");
  });
});
