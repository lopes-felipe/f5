import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSafeZustandStorage,
  safeLocalStorageGetItem,
  safeLocalStorageGetMigrated,
  safeLocalStorageRemoveItem,
  safeLocalStorageSetItem,
} from "./safeStorage";

function stubMemoryLocalStorage() {
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
  return data;
}

describe("safeStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads, writes, and removes items when localStorage works", () => {
    stubMemoryLocalStorage();

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

  it("migrates legacy keys forward on first read while preferring the primary key", () => {
    const data = stubMemoryLocalStorage();
    data.set("t3code:theme", "dark");

    expect(safeLocalStorageGetMigrated("f5:theme", "t3code:theme")).toBe("dark");
    expect(data.get("f5:theme")).toBe("dark");
    expect(data.get("t3code:theme")).toBe("dark");

    data.set("f5:theme", "light");
    expect(safeLocalStorageGetMigrated("f5:theme", "t3code:theme")).toBe("light");
  });

  it("creates a safe Zustand storage adapter with legacy key fallback", () => {
    const data = stubMemoryLocalStorage();
    data.set("t3code:agents-panel:v1", '{"state":{"scope":"all"}}');

    const storage = createSafeZustandStorage("t3code:agents-panel:v1");
    expect(storage.getItem("f5:agents-panel:v1")).toBe('{"state":{"scope":"all"}}');
    expect(data.get("f5:agents-panel:v1")).toBe('{"state":{"scope":"all"}}');

    storage.setItem("f5:agents-panel:v1", '{"state":{"scope":"thread"}}');
    expect(data.get("f5:agents-panel:v1")).toBe('{"state":{"scope":"thread"}}');

    storage.removeItem("f5:agents-panel:v1");
    expect(data.has("f5:agents-panel:v1")).toBe(false);
  });
});
