import { assert, describe, it } from "@effect/vitest";

import { isPreviewableUrl, normalizePreviewUrl, PreviewUrlNormalizationError } from "./preview";

describe("preview URL helpers", () => {
  it("normalizes bare loopback URLs to http", () => {
    assert.equal(normalizePreviewUrl("localhost:5173"), "http://localhost:5173/");
    assert.equal(normalizePreviewUrl("127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
  });

  it("rejects non-loopback hosts", () => {
    assert.throws(() => normalizePreviewUrl("example.com/path"), PreviewUrlNormalizationError);
  });

  it("rejects unsupported protocols", () => {
    assert.throws(
      () => normalizePreviewUrl("file:///tmp/index.html"),
      PreviewUrlNormalizationError,
    );
  });

  it("detects previewable loopback urls", () => {
    assert.equal(isPreviewableUrl("http://localhost:5173"), true);
    assert.equal(isPreviewableUrl("https://example.com"), false);
  });
});
