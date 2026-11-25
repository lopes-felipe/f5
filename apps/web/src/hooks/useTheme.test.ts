import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredThemeMode, THEME_MODE_STORAGE_KEY } from "../themeMode";
import { resetThemeStateForTests } from "./useTheme";

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
});
