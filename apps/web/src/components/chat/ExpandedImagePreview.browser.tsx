import "../../index.css";

import { ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { toastManager } from "../ui/toast";
import {
  ExpandedImageDialog,
  type ExpandedImageItem,
  type ExpandedImagePreview,
} from "./ExpandedImagePreview";
import { useImageAttachmentActions } from "./useImageAttachmentActions";

const actionMocks = vi.hoisted(() => ({
  canCopy: vi.fn(),
  copy: vi.fn(),
  download: vi.fn(),
}));
const menuMocks = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock("../../contextMenuFallback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contextMenuFallback")>();
  return {
    ...actual,
    showContextMenuFallback: (
      ...args: Parameters<typeof actual.showContextMenuFallback>
    ): ReturnType<typeof actual.showContextMenuFallback> => {
      if (menuMocks.error) {
        return Promise.reject(menuMocks.error);
      }
      return actual.showContextMenuFallback(...args);
    },
  };
});

vi.mock("./imageAttachmentActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./imageAttachmentActions")>();
  return {
    ...actual,
    canCopyImageToClipboard: actionMocks.canCopy,
    copyImageAttachment: actionMocks.copy,
    downloadImageAttachment: actionMocks.download,
  };
});

vi.mock("../../env", () => ({ isElectron: true }));

const IMAGES: ExpandedImageItem[] = [
  {
    src: "/attachments/first",
    previewSrc: "/attachments/first",
    name: "first.png",
    mimeType: "image/png",
  },
  {
    src: "/attachments/second",
    previewSrc: "/attachments/second",
    name: "second.gif",
    mimeType: "image/gif",
  },
];

function ImageDialogHarness({ onClose = () => {} }: { onClose?: () => void }) {
  const [preview, setPreview] = useState<ExpandedImagePreview>({ images: IMAGES, index: 0 });
  const actions = useImageAttachmentActions(ThreadId.makeUnsafe("thread-image-actions"));
  return (
    <ExpandedImageDialog
      preview={preview}
      canCopyImage={actions.canCopyImage}
      usesCustomImageContextMenu={actions.usesCustomImageContextMenu}
      pendingAction={actions.pendingAction}
      onClose={onClose}
      onNavigate={(direction) => {
        setPreview((current) => ({
          ...current,
          index: (current.index + direction + current.images.length) % current.images.length,
        }));
      }}
      onAction={(action, item) => {
        void actions.runImageAction(action, item);
      }}
      onActionMenu={(item, position) => {
        void actions.showImageActionMenu(item, position);
      }}
    />
  );
}

describe("ExpandedImageDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    actionMocks.canCopy.mockReset();
    actionMocks.canCopy.mockReturnValue(true);
    actionMocks.copy.mockReset();
    actionMocks.copy.mockResolvedValue(undefined);
    actionMocks.download.mockReset();
    actionMocks.download.mockResolvedValue(undefined);
    menuMocks.error = null;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("runs toolbar actions against the currently selected gallery image", async () => {
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      await page.getByRole("button", { name: "Copy image" }).click();
      await vi.waitFor(() => {
        expect(actionMocks.copy).toHaveBeenCalledWith(IMAGES[0]);
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ type: "success", title: "Image copied" }),
        );
      });

      await page.getByRole("button", { name: "Next image" }).click();
      await vi.waitFor(() => {
        expect(host.querySelector('img[alt="second.gif"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Download image" }).click();
      await vi.waitFor(() => {
        expect(actionMocks.download).toHaveBeenCalledWith(IMAGES[1]);
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({ type: "success", title: "Image download started" }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps user activation through the Electron image menu and applies Copy", async () => {
    let copyHadUserActivation: boolean | null = null;
    actionMocks.copy.mockImplementation(async () => {
      copyHadUserActivation = navigator.userActivation?.isActive ?? null;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      const image = host.querySelector('img[alt="first.png"]');
      expect(image).not.toBeNull();
      image!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 42,
          clientY: 84,
        }),
      );

      await vi.waitFor(() => {
        expect(
          Array.from(document.body.querySelectorAll("button")).some(
            (button) => button.textContent === "Copy image",
          ),
        ).toBe(true);
      });
      await page.getByText("Copy image", { exact: true }).click();

      await vi.waitFor(() => {
        expect(actionMocks.copy).toHaveBeenCalledWith(IMAGES[0]);
        expect(copyHadUserActivation).toBe(true);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("does not intercept copy shortcuts or offer Copy when binary clipboard writes are unavailable", async () => {
    actionMocks.canCopy.mockReturnValue(false);
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      const shortcut = new KeyboardEvent("keydown", {
        key: "c",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(shortcut);
      expect(shortcut.defaultPrevented).toBe(false);
      expect(actionMocks.copy).not.toHaveBeenCalled();

      host
        .querySelector('img[alt="first.png"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => {
        expect(
          Array.from(document.body.querySelectorAll("button")).some(
            (button) => button.textContent === "Download image",
          ),
        ).toBe(true);
      });
      expect(
        Array.from(document.body.querySelectorAll("button")).some(
          (button) => button.textContent === "Copy image",
        ),
      ).toBe(false);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("reports context-menu failures instead of leaking an unhandled rejection", async () => {
    menuMocks.error = new Error("Menu rendering failed");
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      host
        .querySelector('img[alt="first.png"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not open image actions",
            description: "Menu rendering failed",
          }),
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("dismisses the image menu without running an action", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      host
        .querySelector('img[alt="first.png"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Download image");
      });

      const overlay = document.body.querySelector<HTMLElement>('div[style*="z-index: 9999"]');
      expect(overlay).not.toBeNull();
      overlay!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain("Download image");
      });
      expect(actionMocks.copy).not.toHaveBeenCalled();
      expect(actionMocks.download).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("ignores duplicate actions while one image operation is pending", async () => {
    let resolveCopy = () => {};
    actionMocks.copy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      const copyButton = host.querySelector<HTMLButtonElement>('button[aria-label="Copy image"]');
      expect(copyButton).not.toBeNull();
      copyButton!.click();
      copyButton!.click();
      expect(actionMocks.copy).toHaveBeenCalledOnce();
      resolveCopy();
      await vi.waitFor(() => {
        expect(copyButton!.disabled).toBe(false);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("copies the selected image with Cmd/Ctrl+C and preserves gallery keyboard navigation", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      await vi.waitFor(() => {
        expect(host.querySelector('img[alt="second.gif"]')).not.toBeNull();
      });

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", metaKey: true }));
      await vi.waitFor(() => {
        expect(actionMocks.copy).toHaveBeenCalledWith(IMAGES[1]);
      });

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
      await vi.waitFor(() => {
        expect(host.querySelector('img[alt="first.png"]')).not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the viewer open and reports action failures", async () => {
    actionMocks.download.mockRejectedValue(
      new Error("The image attachment is no longer available."),
    );
    const toastSpy = vi.spyOn(toastManager, "add");
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<ImageDialogHarness />, { container: host });

    try {
      await page.getByRole("button", { name: "Download image" }).click();

      await vi.waitFor(() => {
        expect(toastSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            title: "Could not download image",
            description: "The image attachment is no longer available.",
          }),
        );
        expect(host.querySelector('[role="dialog"]')).not.toBeNull();
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
