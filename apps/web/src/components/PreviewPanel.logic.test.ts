import { describe, expect, it } from "vitest";

import {
  readReadyWebContentsId,
  readReadyWebviewValue,
  isPreviewWebviewNotReadyError,
} from "./PreviewPanel.logic";

describe("isPreviewWebviewNotReadyError", () => {
  it("detects Electron webview readiness errors", () => {
    expect(isPreviewWebviewNotReadyError(new Error("Cannot call getURL before dom-ready"))).toBe(
      true,
    );
    expect(
      isPreviewWebviewNotReadyError(new Error("The WebView must be attached to the DOM")),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isPreviewWebviewNotReadyError(new Error("renderer crashed"))).toBe(false);
  });
});

describe("readReadyWebviewValue", () => {
  it("returns fallback for not-yet-ready webview errors", () => {
    expect(
      readReadyWebviewValue(() => {
        throw new Error("Cannot call getTitle before dom-ready");
      }, "last title"),
    ).toBe("last title");
  });

  it("returns fallback for undefined, null, and empty string values", () => {
    expect(readReadyWebviewValue(() => undefined, "fallback")).toBe("fallback");
    expect(readReadyWebviewValue(() => null as string | null, "fallback")).toBe("fallback");
    expect(readReadyWebviewValue(() => "", "fallback")).toBe("fallback");
  });

  it("preserves false values", () => {
    expect(readReadyWebviewValue(() => false, true)).toBe(false);
  });

  it("rethrows unrelated errors", () => {
    expect(() =>
      readReadyWebviewValue(() => {
        throw new Error("renderer crashed");
      }, "fallback"),
    ).toThrow("renderer crashed");
  });
});

describe("readReadyWebContentsId", () => {
  it("returns positive web contents ids", () => {
    expect(readReadyWebContentsId({ getWebContentsId: () => 42 })).toBe(42);
  });

  it("returns null for missing or not-yet-ready ids", () => {
    expect(readReadyWebContentsId({})).toBeNull();
    expect(readReadyWebContentsId({ getWebContentsId: () => 0 })).toBeNull();
    expect(
      readReadyWebContentsId({
        getWebContentsId: () => {
          throw new Error("WebView must be attached to the DOM");
        },
      }),
    ).toBeNull();
  });
});
