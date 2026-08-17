import { describe, expect, it } from "vitest";

import { fetchPreviewFaviconDataUrl, type PreviewFaviconFetch } from "./previewFavicon";

function response(bytes: Uint8Array, options?: { status?: number; location?: string }) {
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    status: options?.status ?? 200,
    headers: new Headers(options?.location ? { location: options.location } : {}),
    body: new Blob([body]).stream(),
  };
}

describe("preview favicon authorization", () => {
  it("accepts a signed same-origin image and returns inert data", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dataUrl = await fetchPreviewFaviconDataUrl({
      pageUrl: "http://localhost:5173/app",
      candidateUrls: ["/favicon.png"],
      fetchImplementation: async () => response(png),
    });
    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  });

  it("rejects cross-origin candidates, redirects, and spoofed image content", async () => {
    let calls = 0;
    const fetchImplementation: PreviewFaviconFetch = async (url) => {
      calls += 1;
      if (url.endsWith("redirect.ico")) {
        return response(new Uint8Array(), {
          status: 302,
          location: "https://attacker.example/icon.ico",
        });
      }
      return response(new TextEncoder().encode("<svg><script>alert(1)</script></svg>"));
    };
    const dataUrl = await fetchPreviewFaviconDataUrl({
      pageUrl: "http://localhost:5173/app",
      candidateUrls: ["https://attacker.example/icon.png", "/redirect.ico", "/spoofed.png"],
      fetchImplementation,
    });
    expect(dataUrl).toBeNull();
    expect(calls).toBe(2);
  });

  it("rejects a favicon declared above the one-megabyte cap without reading it", async () => {
    let cancelled = false;
    const dataUrl = await fetchPreviewFaviconDataUrl({
      pageUrl: "http://localhost:5173/",
      candidateUrls: ["/huge.png"],
      fetchImplementation: async () => ({
        status: 200,
        headers: new Headers({ "content-length": String(1024 * 1024 + 1) }),
        body: new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
      }),
    });
    expect(dataUrl).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("cancels an obsolete fetch when its caller aborts", async () => {
    const controller = new AbortController();
    const result = fetchPreviewFaviconDataUrl({
      pageUrl: "http://localhost:5173/",
      candidateUrls: ["/slow.png"],
      signal: controller.signal,
      fetchImplementation: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });

    controller.abort();
    await expect(result).resolves.toBeNull();
  });
});
