import { afterEach, describe, expect, it, vi } from "vitest";
import {
  safeLocalStorageGetItem,
  safeLocalStorageRemoveItem,
  safeLocalStorageSetItem,
} from "./safeStorage";

describe("safeStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads, writes, and removes items when localStorage works", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
          data.set(key, value);
        },
        removeItem: (key: string) => {
          data.delete(key);
        },
      },
    });

    expect(safeLocalStorageGetItem("k")).toBeNull();
    expect(safeLocalStorageSetItem("k", "v")).toBe(true);
    expect(safeLocalStorageGetItem("k")).toBe("v");
    expect(safeLocalStorageRemoveItem("k")).toBe(true);
    expect(safeLocalStorageGetItem("k")).toBeNull();
  });

  it("returns safe fallbacks when localStorage throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {
          throw new Error("SecurityError");
        },
      },
    });

    expect(safeLocalStorageGetItem("k")).toBeNull();
    expect(safeLocalStorageSetItem("k", "v")).toBe(false);
    expect(safeLocalStorageRemoveItem("k")).toBe(false);
  });

  it("returns safe fallbacks when window.localStorage getter itself throws", () => {
    vi.stubGlobal(
      "window",
      Object.defineProperty({}, "localStorage", {
        get() {
          throw new Error("SecurityError");
        },
      }),
    );

    expect(safeLocalStorageGetItem("k")).toBeNull();
    expect(safeLocalStorageSetItem("k", "v")).toBe(false);
    expect(safeLocalStorageRemoveItem("k")).toBe(false);
  });
});
