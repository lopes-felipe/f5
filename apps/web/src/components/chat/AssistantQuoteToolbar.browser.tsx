import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AssistantQuoteToolbar } from "./AssistantQuoteToolbar";

const nextFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))),
  );

async function renderAnswer() {
  const screen = await render(
    <>
      <p data-message-role="assistant" data-message-id="answer">
        Selected answer
      </p>
      <p data-testid="elsewhere">Unrelated text</p>
      <AssistantQuoteToolbar
        onInsert={() => ({ inserted: true })}
        currentLength={0}
        maxLength={120000}
      />
    </>,
  );
  const paragraph = document.querySelector('[data-message-id="answer"]')!;
  return { screen, paragraph };
}

it("keeps quote actions open after a real triple-click selection", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    await userEvent.tripleClick(paragraph);
    const quote = page.getByRole("button", { name: "Quote reply" });
    await expect.element(quote).toBeVisible();
    // The click that ends the gesture must not dismiss the actions.
    await nextFrames();
    await expect.element(quote).toBeVisible();
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("keeps quote actions open through the click that ends a drag selection", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, paragraph.firstChild!, 8);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    const quote = page.getByRole("button", { name: "Quote reply" });
    await expect.element(quote).toBeVisible();
    paragraph.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextFrames();
    await expect.element(quote).toBeVisible();
    // A new press elsewhere clears the actions; a press inside them does not.
    page
      .getByRole("toolbar", { name: "Quote assistant response" })
      .element()
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await nextFrames();
    await expect.element(quote).toBeVisible();
    document
      .querySelector('[data-testid="elsewhere"]')!
      .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.element(quote).not.toBeInTheDocument();
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("offers a quote for a keyboard selection and lets Escape dismiss it", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    // No pointer events: keyboard selections only report through selectionchange.
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, paragraph.firstChild!, 8);
    const quote = page.getByRole("button", { name: "Quote reply" });
    await expect.element(quote).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(quote).not.toBeInTheDocument();
    await nextFrames();
    await expect.element(quote).not.toBeInTheDocument();
    expect(window.getSelection()!.toString()).toBe("Selected");
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("restores the quoted selection when stepping back from the comment", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, paragraph.firstChild!, 8);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("textbox", { name: "Quote comment" }).fill("A comment");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    const quote = page.getByRole("button", { name: "Quote reply" });
    await expect.element(quote).toBeVisible();
    await expect.poll(() => window.getSelection()!.toString()).toBe("Selected");
    await expect.poll(() => document.activeElement).toBe(quote.element());
    await nextFrames();
    await expect.element(quote).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(quote).not.toBeInTheDocument();
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("keeps stepped-back actions when the quoted text re-rendered, until focus moves on", async () => {
  const { screen, paragraph } = await renderAnswer();
  const outside = document.createElement("button");
  outside.textContent = "Outside";
  document.body.append(outside);
  try {
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, paragraph.firstChild!, 8);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("textbox", { name: "Quote comment" }).fill("A comment");
    // A re-render replaces the quoted text node, collapsing the saved range.
    paragraph.replaceChildren(document.createTextNode("Selected answer"));
    await page.getByRole("button", { name: "Back", exact: true }).click();
    const quote = page.getByRole("button", { name: "Quote reply" });
    await nextFrames();
    await expect.element(quote).toBeVisible();
    await quote.click();
    await expect
      .element(page.getByRole("textbox", { name: "Quote comment" }))
      .toHaveValue("A comment");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await nextFrames();
    outside.focus();
    await expect.element(quote).not.toBeInTheDocument();
  } finally {
    outside.remove();
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("offers a quote when paragraph selection ends beyond an unselectable tool row", async () => {
  const insert = vi.fn(() => ({ inserted: true }));
  const screen = await render(
    <>
      <p data-message-role="assistant" data-message-id="answer">
        Selected answer
      </p>
      <div style={{ userSelect: "none" }}>Tool output</div>
      <p data-message-role="assistant" data-message-id="next">
        Next answer
      </p>
      <AssistantQuoteToolbar onInsert={insert} currentLength={0} maxLength={120000} />
    </>,
  );
  try {
    const paragraph = document.querySelector('[data-message-id="answer"]')!;
    const next = document.querySelector('[data-message-id="next"]')!;
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, next, 0);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("button", { name: "Add quote to composer" }).click();
    expect(insert).toHaveBeenCalledWith(
      { messageId: "answer", text: "Selected answer", comment: "" },
      false,
    );
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

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
