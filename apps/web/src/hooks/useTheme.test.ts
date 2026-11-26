import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredThemeMode, THEME_MODE_STORAGE_KEY } from "../themeMode";
import {
  getThemeSnapshotForTests,
  resetThemeStateForTests,
  setThemeMode,
  subscribeThemeForTests,
} from "./useTheme";

describe("themeMode & useTheme storage resilience", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetThemeStateForTests();
  });

  it("falls back to system when localStorage.getItem throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError: storage denied");
        },
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      },
    });

    expect(readStoredThemeMode()).toBe("system");
  });

  it("reads valid persisted theme modes", () => {
    const store = new Map<string, string>([[THEME_MODE_STORAGE_KEY, "dark"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });

    expect(readStoredThemeMode()).toBe("dark");
  });

  it("keeps an unpersisted local theme selection across external storage events until a later write persists", () => {
    const store = new Map<string, string>([[THEME_MODE_STORAGE_KEY, "dark"]]);
    let failWrites = true;
    const storageListeners = new Set<(event: StorageEvent) => void>();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (failWrites) throw new Error("QuotaExceededError");
          store.set(key, value);
        },
        removeItem: (key: string) => store.delete(key),
      },
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      addEventListener: (event: string, listener: EventListener) => {
        if (event === "storage") storageListeners.add(listener as (event: StorageEvent) => void);
      },
      removeEventListener: (event: string, listener: EventListener) => {
        if (event === "storage") storageListeners.delete(listener as (event: StorageEvent) => void);
      },
    });

    const unsubscribe = subscribeThemeForTests(() => {});
    try {
      setThemeMode("light");
      expect(getThemeSnapshotForTests().theme).toBe("light");

      for (const listener of storageListeners) {
        listener({ key: THEME_MODE_STORAGE_KEY } as StorageEvent);
      }
      expect(getThemeSnapshotForTests().theme).toBe("light");

      failWrites = false;
      setThemeMode("dark");
      expect(getThemeSnapshotForTests().theme).toBe("dark");

      store.set(THEME_MODE_STORAGE_KEY, "light");
      for (const listener of storageListeners) {
        listener({ key: THEME_MODE_STORAGE_KEY } as StorageEvent);
      }
      expect(getThemeSnapshotForTests().theme).toBe("light");
    } finally {
      unsubscribe();
    }
  });
});
