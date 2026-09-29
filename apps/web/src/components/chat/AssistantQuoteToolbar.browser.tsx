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
