import { afterEach, expect, it, vi } from "vitest";
import { readBoundedPreview } from "./readBoundedPreview";
afterEach(() => vi.unstubAllGlobals());
it("cancels a declared oversized response before reading its body", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({ cancel });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { headers: { "content-length": "100" } })),
  );
  await expect(readBoundedPreview("/large", new AbortController().signal, 10)).rejects.toThrow(
    "size limit",
  );
  expect(cancel).toHaveBeenCalledOnce();
});
it("bounds streamed bodies even without trustworthy size metadata", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(11));
    },
    cancel,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body)),
  );
  await expect(readBoundedPreview("/large", new AbortController().signal, 10)).rejects.toThrow(
    "size limit",
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
it("preserves exact bytes at the limit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  expect(
    new Uint8Array(await readBoundedPreview("/small", new AbortController().signal, 3)),
  ).toEqual(new Uint8Array([1, 2, 3]));
});
