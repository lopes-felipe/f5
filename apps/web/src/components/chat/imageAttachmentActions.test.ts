import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canCopyImageToClipboard,
  copyImageAttachment,
  downloadImageAttachment,
  fetchImageAttachmentBlob,
  rasterizeImageBlobToPng,
  sanitizeImageDownloadFilename,
  type ImageAttachmentActionItem,
} from "./imageAttachmentActions";

const IMAGE_ITEM: ImageAttachmentActionItem = {
  src: "https://f5.test/attachments/image-1",
  name: "screen.png",
  mimeType: "image/png",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("imageAttachmentActions", () => {
  it("uses retained optimistic bytes without fetching a possibly revoked preview URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const sourceBlob = new Blob(["fresh image"], { type: "image/png" });

    await expect(
      fetchImageAttachmentBlob({
        src: "blob:revoked-preview",
        name: "fresh.png",
        mimeType: "image/png",
        sourceBlob,
      }),
    ).resolves.toBe(sourceBlob);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads authenticated image bytes and restores the metadata MIME type when needed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["image-bytes"], { type: "application/octet-stream" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await fetchImageAttachmentBlob(IMAGE_ITEM);

    expect(fetchMock).toHaveBeenCalledWith(IMAGE_ITEM.src, {
      credentials: "include",
      cache: "no-store",
    });
    expect(blob.type).toBe("image/png");
    expect(await blob.text()).toBe("image-bytes");
  });

  it("reports missing persisted attachments clearly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));

    await expect(fetchImageAttachmentBlob(IMAGE_ITEM)).rejects.toThrow(
      "The image attachment is no longer available.",
    );
  });

  it("rejects successful responses whose bytes are explicitly not an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>proxy error</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    );

    await expect(fetchImageAttachmentBlob(IMAGE_ITEM)).rejects.toThrow(
      "The attachment did not contain a supported image.",
    );
  });

  it("passes PNG blobs through without rasterizing them", async () => {
    const png = new Blob(["png"], { type: "image/png" });
    await expect(rasterizeImageBlobToPng(png)).resolves.toBe(png);
  });

  it("rasterizes non-PNG images and releases the decoded bitmap", async () => {
    const close = vi.fn();
    const bitmap = { width: 24, height: 16, close };
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue({ drawImage }),
      toBlob: vi.fn((callback: BlobCallback, mimeType: string) => {
        callback(new Blob(["png-result"], { type: mimeType }));
      }),
    };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal("document", { createElement: vi.fn().mockReturnValue(canvas) });

    const result = await rasterizeImageBlobToPng(new Blob(["jpeg-source"], { type: "image/jpeg" }));

    expect(canvas.width).toBe(24);
    expect(canvas.height).toBe(16);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(result.type).toBe("image/png");
    expect(await result.text()).toBe("png-result");
    expect(close).toHaveBeenCalledOnce();
  });

  it("starts clipboard writes inside the user gesture with a PNG promise", async () => {
    class FakeClipboardItem {
      constructor(readonly entries: Record<string, Blob | Promise<Blob>>) {}
    }
    const write = vi.fn(async (items: FakeClipboardItem[]) => {
      const png = await items[0]?.entries["image/png"];
      expect(png).toBeInstanceOf(Blob);
      expect((png as Blob).type).toBe("image/png");
      expect(await (png as Blob).text()).toBe("clipboard-png");
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Blob(["clipboard-png"], { type: "image/png" }), { status: 200 }),
        ),
    );
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    expect(canCopyImageToClipboard()).toBe(true);
    await copyImageAttachment(IMAGE_ITEM);

    expect(write).toHaveBeenCalledOnce();
  });

  it("uses the native desktop clipboard bridge when available", async () => {
    const copyImage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { desktopBridge: { copyImage } });
    vi.stubGlobal("navigator", { clipboard: {} });
    vi.stubGlobal("ClipboardItem", undefined);

    expect(canCopyImageToClipboard()).toBe(true);
    await copyImageAttachment({
      ...IMAGE_ITEM,
      sourceBlob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    });

    expect(copyImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });

  it("rejects copy requests when binary clipboard writes are unavailable", async () => {
    vi.stubGlobal("navigator", { clipboard: {} });
    vi.stubGlobal("ClipboardItem", undefined);

    expect(canCopyImageToClipboard()).toBe(false);
    await expect(copyImageAttachment(IMAGE_ITEM)).rejects.toThrow(
      "Image copying is not supported in this environment.",
    );
  });

  it("preserves attachment preparation errors when clipboard writing rejects first", async () => {
    class FakeClipboardItem {
      constructor(readonly entries: Record<string, Blob | Promise<Blob>>) {}
    }
    const write = vi.fn().mockRejectedValue(new DOMException("Not allowed", "NotAllowedError"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })));
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    await expect(copyImageAttachment(IMAGE_ITEM)).rejects.toThrow(
      "The image attachment is no longer available.",
    );
    expect(write).toHaveBeenCalledOnce();
  });

  it("reports clipboard permission errors after image preparation succeeds", async () => {
    class FakeClipboardItem {
      constructor(readonly entries: Record<string, Blob | Promise<Blob>>) {}
    }
    const clipboardError = new DOMException("Not allowed", "NotAllowedError");
    const write = vi.fn().mockRejectedValue(clipboardError);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" }))),
    );
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);

    await expect(copyImageAttachment(IMAGE_ITEM)).rejects.toBe(clipboardError);
  });

  it("downloads the exact original blob with a safe filename and delayed URL cleanup", async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = {
      href: "",
      download: "",
      style: { display: "" },
      click,
      remove,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Blob(["GIF89a"], { type: "image/gif" }), { status: 200 }),
        ),
    );
    vi.stubGlobal("document", {
      body: { append },
      createElement: vi.fn().mockReturnValue(anchor),
    });
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    await downloadImageAttachment({
      ...IMAGE_ITEM,
      name: 'capture/one:"final".gif',
      mimeType: "image/gif",
    });

    const downloadedBlob = createObjectUrl.mock.calls[0]?.[0];
    expect(downloadedBlob).toBeInstanceOf(Blob);
    expect((downloadedBlob as Blob).type).toBe("image/gif");
    expect(await (downloadedBlob as Blob).text()).toBe("GIF89a");
    expect(anchor.download).toBe("capture_one__final_.gif");
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:download");
  });

  it("uses the native desktop download bridge with original bytes and a safe filename", async () => {
    const downloadImage = vi.fn().mockResolvedValue({
      savedPath: "/Users/test/Downloads/capture_one.gif",
    });
    vi.stubGlobal("window", { desktopBridge: { downloadImage } });

    await downloadImageAttachment({
      ...IMAGE_ITEM,
      name: "capture/one.gif",
      mimeType: "image/gif",
      sourceBlob: new Blob([new Uint8Array([71, 73, 70])], { type: "image/gif" }),
    });

    expect(downloadImage).toHaveBeenCalledWith(new Uint8Array([71, 73, 70]), "capture_one.gif");
  });

  it("uses a stable fallback for unsafe or empty download names", () => {
    expect(sanitizeImageDownloadFilename(" ../shot?.png ")).toBe(".._shot_.png");
    expect(sanitizeImageDownloadFilename("... ")).toBe("image");
    expect(sanitizeImageDownloadFilename("\u0000\u001f")).toBe("__");
    expect(sanitizeImageDownloadFilename("capture.png... ")).toBe("capture.png");
    expect(sanitizeImageDownloadFilename("NUL.png")).toBe("_NUL.png");

    const longName = sanitizeImageDownloadFilename(`${"a".repeat(300)}.png`);
    expect(Array.from(longName)).toHaveLength(240);
    expect(longName.endsWith(".png")).toBe(true);
  });
});
