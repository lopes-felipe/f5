import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AssistantMessageActions } from "./AssistantMessageActions";
import { toastManager } from "../ui/toast";

describe("AssistantMessageActions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("copies the exact raw markdown and shows success feedback", async () => {
    const rawText = "# Heading\n\n- item\n\n```ts\nconst x = 1;\n```";
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<AssistantMessageActions rawText={rawText} />, { container: host });

    try {
      await page.getByRole("button", { name: "Message actions" }).click();
      await page.getByRole("menuitem", { name: "Copy raw markdown" }).click();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(rawText);
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "success",
            title: "Raw markdown copied",
          }),
        );
      });

      await page.getByRole("button", { name: "Message actions" }).click();
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Copied");
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("disables copying when the raw markdown is empty", async () => {
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<AssistantMessageActions rawText="" />, { container: host });

    try {
      await page.getByRole("button", { name: "Message actions" }).click();
      const menuItem = document.querySelector('[data-slot="menu-item"]');
      expect(menuItem?.getAttribute("data-disabled")).toBe("");
      (menuItem as HTMLButtonElement | null)?.click();

      const clipboardSpy = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
      expect(clipboardSpy).not.toHaveBeenCalled();
      expect(toastSpy).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("shows an error toast when clipboard writes fail", async () => {
    const clipboardError = new Error("Permission denied");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(clipboardError),
      },
    });
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<AssistantMessageActions rawText="partial response" />, {
      container: host,
    });

    try {
      await page.getByRole("button", { name: "Message actions" }).click();
      await page.getByRole("menuitem", { name: "Copy raw markdown" }).click();

      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not copy raw markdown",
            description: "Permission denied",
          }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("copies the latest raw markdown after props update", async () => {
    const updatedText = "draft\nmore";
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<AssistantMessageActions rawText="draft" />, {
      container: host,
    });

    try {
      await screen.rerender(<AssistantMessageActions rawText={updatedText} />);
      await page.getByRole("button", { name: "Message actions" }).click();
      await page.getByRole("menuitem", { name: "Copy raw markdown" }).click();

      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(updatedText);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
