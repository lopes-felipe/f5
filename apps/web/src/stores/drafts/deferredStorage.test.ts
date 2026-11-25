import { describe, expect, it, vi } from "vitest";

import {
  COMPOSER_DRAFT_PERSISTENCE_ERROR_EVENT,
  createDebouncedStorage,
  createDeferredStorage,
  createMemoryStateStorage,
  isStateStorage,
} from "./deferredStorage";

describe("deferredStorage", () => {
  it("coalesces rapid writes, exposes pendingValue, and flushes cleanly without hydrating composerDraftStore", () => {
    vi.useFakeTimers();
    try {
      const backing = createMemoryStateStorage();
      const setSpy = vi.spyOn(backing, "setItem");
      const deferred = createDeferredStorage<string>(backing, (value) => value);

      deferred.setItem("k", "v1");
      deferred.setItem("k", "v2");
      expect(deferred.pendingValue("k")).toBe("v2");
      expect(setSpy).not.toHaveBeenCalled();

      deferred.flush();
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(backing.getItem("k")).toBe("v2");
      expect(deferred.pendingValue("k")).toBeNull();

      const debounced = createDebouncedStorage(backing);
      expect(isStateStorage(backing)).toBe(true);
      expect(isStateStorage(null)).toBe(false);
      debounced.removeItem("k");
      debounced.flush();
      expect(backing.getItem("k")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches the persistence error event when a deferred write throws", () => {
    const dispatched: Array<CustomEvent> = [];
    const prevWindow = globalThis.window;
    globalThis.window = {
      dispatchEvent: (event: Event) => {
        dispatched.push(event as CustomEvent);
        return true;
      },
    } as unknown as Window & typeof globalThis;

    try {
      const failingStorage = {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => {},
      };
      const deferred = createDeferredStorage<string>(failingStorage, (value) => value);
      deferred.setItem("k", "payload");
      deferred.flush();

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.type).toBe(COMPOSER_DRAFT_PERSISTENCE_ERROR_EVENT);
      expect(dispatched[0]?.detail).toBe("QuotaExceededError");
    } finally {
      globalThis.window = prevWindow;
    }
  });
});
