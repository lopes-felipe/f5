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

function caption() {
  return document.querySelector("[data-ladder-caption]")?.textContent;
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
      "Accept editsEdits apply",
      "SupervisedAsks first",
    ]);
    expect(caption()).toBe("Edits apply on their own; asks before most other actions.");

    const selected = document.querySelectorAll('[data-ladder-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.closest("[data-runtime-mode]")?.getAttribute("data-runtime-mode")).toBe(
      "auto-accept-edits",
    );
    expect(selected[0]?.className).toContain("forced-colors:bg-[color:Highlight]");

    // Descriptions are also the row tooltips.
    const autoDescription =
      "The provider's AI reviewer approves, not F5. It can allow risky commands without asking.";
    await expect
      .element(page.getByRole("menuitemradio", { name: /Auto AI approves/ }))
      .toHaveAttribute("title", autoDescription);

    // Highlighting a row previews its fill and caption; leaving the rows restores the selection.
    await page.getByRole("menuitemradio", { name: /^Auto/ }).hover();
    await vi.waitFor(() => {
      expect(filledModes()).toEqual(["auto", "auto-accept-edits", "approval-required"]);
      expect(caption()).toBe(autoDescription);
    });
    await page.getByRole("button").hover();
    await vi.waitFor(() => {
      expect(filledModes()).toEqual(["auto-accept-edits", "approval-required"]);
      expect(caption()).toBe("Edits apply on their own; asks before most other actions.");
    });
  });

  it("opens from the keyboard on the current mode and previews navigation from there", async () => {
    await mountPicker({ value: "auto-accept-edits" });
    page.getByRole("button").element().focus();
    await userEvent.keyboard("{ArrowDown}");

    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute("data-runtime-mode")).toBe("auto-accept-edits");
    });
    expect(filledModes()).toEqual(["auto-accept-edits", "approval-required"]);

    await userEvent.keyboard("{ArrowUp}");
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

  it("keeps Supervised when the menu is opened and confirmed from the keyboard", async () => {
    const onValueChange = vi.fn();
    await mountPicker({ value: "approval-required", onValueChange });
    page.getByRole("button").element().focus();
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute("data-runtime-mode")).toBe("approval-required");
    });

    await userEvent.keyboard("{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onValueChange).not.toHaveBeenCalled();
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

    // Tooltips never show on disabled rows, so the caption carries the reasons.
    expect(caption()).toBe(
      "Edits and commands run without asking." +
        "Auto review is not available for grok." +
        "Edit-only auto-approval is not available for grok.",
    );

    // A DOM click bypasses the disabled row's pointer-events guard. Choosing an enabled row
    // afterwards proves the disabled click was dropped, not just reported late.
    (page.getByRole("menuitemradio", { name: /^Auto/ }).element() as HTMLElement).click();
    await page.getByRole("menuitemradio", { name: /Supervised/ }).click();
    await vi.waitFor(() => {
      expect(onValueChange).toHaveBeenCalled();
    });
    expect(onValueChange.mock.calls).toEqual([["approval-required"]]);
  });

  it("fills a saved mode the provider no longer offers only up to a supported one", async () => {
    // Antigravity Auto can resume from a saved selection before its snapshot offers it.
    await mountPicker({ provider: "antigravity", value: "auto" });
    page.getByRole("button").element().focus();
    await userEvent.keyboard("{ArrowDown}");

    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute("data-runtime-mode")).toBe("auto-accept-edits");
    });
    expect(filledModes()).toEqual(["auto-accept-edits", "approval-required"]);
    expect(document.querySelectorAll('[data-ladder-selected="true"]')).toHaveLength(0);
    await expect
      .element(page.getByRole("menuitemradio", { name: /^Auto/ }))
      .toHaveTextContent("Current · unavailable");
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
