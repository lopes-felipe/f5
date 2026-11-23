import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { useRef } from "react";
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

const selectAnswer = (paragraph: Element) => {
  window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, paragraph.firstChild!, 8);
  paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
};

it("restores a stepped-back quote whose row moved while the comment was open", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    selectAnswer(paragraph);
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("textbox", { name: "Quote comment" }).fill("A comment");
    // A virtualized list moves rows out of and back into the DOM, keeping their text nodes.
    const parent = paragraph.parentNode!;
    const next = paragraph.nextSibling;
    paragraph.remove();
    parent.insertBefore(paragraph, next);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    const quote = page.getByRole("button", { name: "Quote reply" });
    await expect.poll(() => window.getSelection()!.toString()).toBe("Selected");
    const text = document.createRange();
    text.setStart(paragraph.firstChild!, 0);
    text.setEnd(paragraph.firstChild!, 8);
    const popup = quote.element().getBoundingClientRect();
    expect(popup.left < text.getBoundingClientRect().right).toBe(true);
    expect(popup.right > text.getBoundingClientRect().left).toBe(true);
    await quote.click();
    await expect
      .element(page.getByRole("textbox", { name: "Quote comment" }))
      .toHaveValue("A comment");
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("drops a stepped-back quote whose text was replaced while the comment was open", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    selectAnswer(paragraph);
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("textbox", { name: "Quote comment" }).fill("A comment");
    paragraph.replaceChildren(document.createTextNode("Selected answer"));
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Quote reply" })).not.toBeInTheDocument();
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("steps back from the comment on Escape from the text box or a button", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    selectAnswer(paragraph);
    const quote = page.getByRole("button", { name: "Quote reply" });
    const comment = page.getByRole("textbox", { name: "Quote comment" });
    await quote.click();
    await comment.fill("A comment");
    await userEvent.keyboard("{Escape}");
    await expect.element(comment).not.toBeInTheDocument();
    await expect.element(quote).toBeVisible();
    await quote.click();
    await expect.element(comment).toHaveValue("A comment");
    // Escape with focus on a dialog button goes through the popup's own dismissal.
    page.getByRole("button", { name: "Cancel", exact: true }).element().focus();
    await userEvent.keyboard("{Escape}");
    await expect.element(comment).not.toBeInTheDocument();
    await expect.element(quote).toBeVisible();
    await expect.poll(() => window.getSelection()!.toString()).toBe("Selected");
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("starts a new quote with an empty comment", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    selectAnswer(paragraph);
    const quote = page.getByRole("button", { name: "Quote reply" });
    const comment = page.getByRole("textbox", { name: "Quote comment" });
    await quote.click();
    await comment.fill("For the first passage");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.poll(() => window.getSelection()!.toString()).toBe("Selected");
    // Select a different passage.
    paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 9, paragraph.firstChild!, 15);
    paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await quote.click();
    await expect.element(comment).toHaveValue("");
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("only offers selections inside its own chat", async () => {
  const insertMain = vi.fn(() => ({ inserted: true }));
  const insertSide = vi.fn(() => ({ inserted: true }));
  function Chat({ id, onInsert }: { id: string; onInsert: () => { inserted: boolean } }) {
    const rootRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={rootRef}>
        <p data-message-role="assistant" data-message-id={id}>
          Answer in {id}
        </p>
        <AssistantQuoteToolbar
          onInsert={onInsert}
          currentLength={0}
          maxLength={120000}
          rootRef={rootRef}
        />
      </div>
    );
  }
  const screen = await render(
    <>
      <Chat id="main" onInsert={insertMain} />
      <Chat id="side" onInsert={insertSide} />
    </>,
  );
  try {
    const side = document.querySelector('[data-message-id="side"]')!;
    window.getSelection()!.setBaseAndExtent(side.firstChild!, 0, side.firstChild!, 6);
    side.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await expect.element(page.getByRole("button", { name: "Quote reply" })).toBeVisible();
    await nextFrames();
    expect(page.getByRole("button", { name: "Quote reply" }).elements()).toHaveLength(1);
    await page.getByRole("button", { name: "Quote reply" }).click();
    await page.getByRole("button", { name: "Add quote to composer" }).click();
    expect(insertSide).toHaveBeenCalledWith(
      { messageId: "side", text: "Answer", comment: "" },
      false,
    );
    expect(insertMain).not.toHaveBeenCalled();
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("hides on presses that stop propagation", async () => {
  const { screen, paragraph } = await renderAnswer();
  const stopper = document.createElement("div");
  stopper.addEventListener("pointerdown", (event) => event.stopPropagation());
  document.body.append(stopper);
  try {
    selectAnswer(paragraph);
    const quote = page.getByRole("button", { name: "Quote reply" });
    await expect.element(quote).toBeVisible();
    stopper.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.element(quote).not.toBeInTheDocument();
  } finally {
    stopper.remove();
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("reads the selection when a press ends without a pointerup", async () => {
  const { screen, paragraph } = await renderAnswer();
  try {
    const quote = page.getByRole("button", { name: "Quote reply" });
    // A touch long-press ends in pointercancel.
    paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, paragraph.firstChild!, 8);
    paragraph.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
    await expect.element(quote).toBeVisible();
    // A release outside the window never arrives; the next buttonless move ends the press.
    paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.element(quote).not.toBeInTheDocument();
    window.getSelection()!.setBaseAndExtent(paragraph.firstChild!, 0, paragraph.firstChild!, 6);
    await nextFrames();
    await expect.element(quote).not.toBeInTheDocument();
    paragraph.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 0 }));
    await expect.element(quote).toBeVisible();
  } finally {
    window.getSelection()?.removeAllRanges();
    await screen.unmount();
  }
});

it("keeps the composer caret when a quote is added right after stepping back", async () => {
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.textContent = "Draft";
  document.body.append(composer);
  const insert = vi.fn(() => {
    // Like the composer: focus it and put the caret at the end.
    composer.focus();
    window.getSelection()!.setBaseAndExtent(composer.firstChild!, 5, composer.firstChild!, 5);
    return { inserted: true };
  });
  const screen = await render(
    <>
      <p data-message-role="assistant" data-message-id="answer">
        Selected answer
      </p>
      <AssistantQuoteToolbar onInsert={insert} currentLength={0} maxLength={120000} />
    </>,
  );
  try {
    const paragraph = document.querySelector('[data-message-id="answer"]')!;
    selectAnswer(paragraph);
    await page.getByRole("button", { name: "Quote reply" }).click();
    // Reopen the comment before the deferred restore of the quoted selection runs.
    (page.getByRole("button", { name: "Back", exact: true }).element() as HTMLElement).click();
    await Promise.resolve();
    (page.getByRole("button", { name: "Quote reply" }).element() as HTMLElement).click();
    await page.getByRole("button", { name: "Add quote to composer" }).click();
    expect(insert).toHaveBeenCalledOnce();
    await nextFrames();
    expect(composer.contains(window.getSelection()!.anchorNode)).toBe(true);
  } finally {
    composer.remove();
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
