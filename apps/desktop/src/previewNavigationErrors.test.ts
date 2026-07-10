import { describe, expect, it } from "vitest";

import { isPreviewNavigationAbortError } from "./previewNavigationErrors";

describe("isPreviewNavigationAbortError", () => {
  it("detects ERR_ABORTED by message", () => {
    expect(isPreviewNavigationAbortError(new Error("net::ERR_ABORTED"))).toBe(true);
  });

  it("detects ERR_ABORTED by structured fields", () => {
    expect(isPreviewNavigationAbortError({ code: "ERR_ABORTED" })).toBe(true);
    expect(isPreviewNavigationAbortError({ errno: -3 })).toBe(true);
    expect(isPreviewNavigationAbortError({ errorCode: -3 })).toBe(true);
  });

  it("ignores unrelated navigation errors", () => {
    expect(isPreviewNavigationAbortError(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(false);
    expect(isPreviewNavigationAbortError({ code: "ERR_FAILED", errno: -2 })).toBe(false);
    expect(isPreviewNavigationAbortError(null)).toBe(false);
  });
});
