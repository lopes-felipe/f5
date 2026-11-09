import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { isPreviewNavigationAbortError, loadPreviewURL } from "./previewNavigationErrors";

describe("loadPreviewURL", () => {
  const url = "https://example.com/";
  const loadError = (errno: number, code: string, target = url) =>
    Object.assign(new Error(code + " (" + errno + ") loading '" + target + "'"), {
      errno,
      code,
      url: target,
    });
  const makeContents = () =>
    Object.assign(new EventEmitter(), { loadURL: vi.fn(async (_url: string) => {}) });

  it("accepts loads superseded by redirects, including redirects to the requested URL", async () => {
    const contents = makeContents();
    for (const target of ["https://example.com/target", url]) {
      contents.loadURL.mockRejectedValueOnce(loadError(-3, "ERR_ABORTED", target));
      await expect(loadPreviewURL(contents, url)).resolves.toBeUndefined();
      expect(contents.loadURL).toHaveBeenLastCalledWith(url);
      expect(contents.listenerCount("will-prevent-unload")).toBe(0);
    }
  });

  it("reports blocked unloads and removes only its own listener", async () => {
    const contents = makeContents();
    const existingListener = vi.fn();
    contents.on("will-prevent-unload", existingListener);
    const error = loadError(-3, "ERR_ABORTED");
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit("will-prevent-unload");
      throw error;
    });
    await expect(loadPreviewURL(contents, url)).rejects.toBe(error);
    expect(contents.listeners("will-prevent-unload")).toEqual([existingListener]);
    // The blocked state must not carry over to the next navigation.
    contents.loadURL.mockRejectedValueOnce(error);
    await expect(loadPreviewURL(contents, url)).resolves.toBeUndefined();
  });

  it("reports real failures and cleans up after failure and success", async () => {
    const contents = makeContents();
    const error = loadError(-105, "ERR_NAME_NOT_RESOLVED");
    contents.loadURL.mockRejectedValueOnce(error);
    await expect(loadPreviewURL(contents, url)).rejects.toBe(error);
    expect(contents.listenerCount("will-prevent-unload")).toBe(0);
    await expect(loadPreviewURL(contents, url)).resolves.toBeUndefined();
    expect(contents.listenerCount("will-prevent-unload")).toBe(0);
  });
});

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
