import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AssistantMessageActions } from "./AssistantMessageActions";
import { MessageCopyButton } from "./MessageCopyButton";
import { toastManager } from "../ui/toast";

describe("AssistantMessageActions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers Quote in reply and calls its callback", async () => {
    const onQuote = vi.fn();
    const screen = await render(<AssistantMessageActions onQuote={onQuote} />);
    try {
      await page.getByRole("button", { name: "Message actions" }).click();
      const quote = page.getByRole("menuitem", { name: "Quote in reply" });
      await expect.element(quote).toBeVisible();
      expect(document.querySelectorAll('[data-slot="menu-item"]')).toHaveLength(1);
      await quote.click();
      expect(onQuote).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });
});

describe("MessageCopyButton", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("copies the exact raw markdown", async () => {
    const rawText = "# Heading\n\n- item\n\n```ts\nconst x = 1;\n```";
    const screen = await render(<MessageCopyButton text={rawText} />);
    try {
      await page.getByRole("button", { name: "Copy message" }).click();
      await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(rawText));
    } finally {
      await screen.unmount();
    }
  });

  it("shows an error toast when clipboard writes fail", async () => {
    vi.spyOn(document, "execCommand").mockReturnValue(false);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) },
    });
    const toastSpy = vi.spyOn(toastManager, "add");
    const screen = await render(<MessageCopyButton text="partial response" />);
    try {
      await page.getByRole("button", { name: "Copy message" }).click();
      await vi.waitFor(() =>
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not copy message",
            description: "Clipboard copy failed.",
          }),
        ),
      );
    } finally {
      await screen.unmount();
    }
  });
});
