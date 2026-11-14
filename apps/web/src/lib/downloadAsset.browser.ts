import { afterEach, expect, it, vi } from "vitest";
import { downloadAsset } from "./downloadAsset";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("downloads a cross-origin inline asset through a blob instead of navigating to its HTTP URL", async () => {
  const clicks: { href: string; name: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, name: this.download });
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response("PDF content", { headers: { "content-type": "application/pdf" } }),
    ),
  );
  await downloadAsset("http://127.0.0.1:9999/file.pdf", "file.pdf");
  expect(clicks).toEqual([{ href: expect.stringMatching(/^blob:/), name: "file.pdf" }]);
  expect(document.querySelector('a[download="file.pdf"]')).toBeNull();
});
