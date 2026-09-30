import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AssistantQuoteToolbar } from "./AssistantQuoteToolbar";

it("dismisses selection actions on other buttons and never inserts a cancelled quote", async () => {
  const insert = vi.fn(() => ({ inserted: true }));
  const screen = await render(
    <>
      <p data-message-role="assistant" data-message-id="answer">
        Selected answer
      </p>
      <button type="button">Another action</button>
      <AssistantQuoteToolbar onInsert={insert} currentLength={0} maxLength={120000} />
    </>,
  );
  const select = () => {
    const paragraph = document.querySelector('[data-message-id="answer"]')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  };
  try {
    select();
    await expect.element(page.getByRole("button", { name: "Quote reply" })).toBeVisible();
    // Keep the DOM selection, as native menu buttons can do.
    page
      .getByRole("button", { name: "Another action" })
      .element()
      .dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await expect.element(page.getByRole("button", { name: "Quote reply" })).not.toBeInTheDocument();
    select();
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("textbox", { name: "Quote comment" }).fill("An unsent comment");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(insert).not.toHaveBeenCalled();
    select();
    await page.getByRole("button", { name: "Quote reply" }).click();
    await expect.element(page.getByRole("textbox", { name: "Quote comment" })).toHaveValue("");
    page
      .getByRole("textbox", { name: "Quote comment" })
      .element()
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          isComposing: true,
          bubbles: true,
        }),
      );
    expect(insert).not.toHaveBeenCalled();
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it.each(["limit", "unconfirmed"])("keeps quote feedback visible for %s", async (scenario) => {
  const insert = vi.fn(async () => ({
    inserted: true,
    error: "Quote added, but sending was not confirmed.",
  }));
  const screen = await render(
    <>
      <p data-message-role="assistant" data-message-id="answer">
        Selected answer
      </p>
      <AssistantQuoteToolbar
        onInsert={insert}
        currentLength={0}
        maxLength={scenario === "limit" ? 8 : 120000}
      />
    </>,
  );
  try {
    const paragraph = document.querySelector('[data-message-id="answer"]')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("button", { name: "Add quote to composer" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        scenario === "limit"
          ? "This quote would exceed the message limit."
          : "Quote added, but sending was not confirmed.",
      );
    if (scenario === "limit") expect(insert).not.toHaveBeenCalled();
    else {
      expect(insert).toHaveBeenCalledOnce();
      await expect
        .element(page.getByRole("button", { name: "Add quote to composer" }))
        .toBeDisabled();
    }
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it.each([
  { placement: "above", spacer: 240 },
  { placement: "below", spacer: 0 },
])("anchors quote actions $placement the selected text", async ({ placement, spacer }) => {
  const screen = await render(
    <>
      <div data-testid="timeline" style={{ height: 480, overflowY: "auto" }}>
        <div style={{ height: spacer }} />
        <p
          data-message-role="assistant"
          data-message-id="answer"
          style={{ margin: "0 0 0 200px", width: 240 }}
        >
          Selected answer
        </p>
        <div style={{ height: 2000 }} />
      </div>
      <AssistantQuoteToolbar
        onInsert={() => ({ inserted: true })}
        currentLength={0}
        maxLength={1}
      />
    </>,
  );
  try {
    const paragraph = document.querySelector('[data-message-id="answer"]')!;
    const range = document.createRange();
    range.selectNodeContents(paragraph.firstChild!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    const toolbar = page.getByRole("toolbar", { name: "Quote assistant response" });
    await expect.element(toolbar).toBeVisible();
    const measure = () => {
      const popup = toolbar.element().getBoundingClientRect();
      const text = range.getBoundingClientRect();
      return {
        overlapsHorizontally: popup.left < text.right && popup.right > text.left,
        gap: Math.round(placement === "above" ? text.top - popup.bottom : popup.top - text.bottom),
      };
    };
    // The positioner transitions between placements, so wait for it to settle.
    await expect.poll(measure).toEqual({ overlapsHorizontally: true, gap: 8 });

    if (placement === "above") {
      const before = toolbar.element().getBoundingClientRect().top;
      document.querySelector('[data-testid="timeline"]')!.scrollTop = 100;
      await expect
        .poll(() => Math.round(before - toolbar.element().getBoundingClientRect().top))
        .toBe(100);
      // Browser tests load no app CSS; `in-data-anchor-hidden:invisible` keys off this attribute.
      document.querySelector('[data-testid="timeline"]')!.scrollTop = 1000;
      await expect
        .poll(() =>
          toolbar
            .element()
            .closest('[data-slot="popover-positioner"]')
            ?.hasAttribute("data-anchor-hidden"),
        )
        .toBe(true);
    }
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});
