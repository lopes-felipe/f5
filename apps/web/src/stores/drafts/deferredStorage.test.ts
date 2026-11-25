import { describe, expect, it, vi } from "vitest";

import {
  createDebouncedStorage,
  createDeferredStorage,
  createMemoryStateStorage,
  isStateStorage,
} from "./deferredStorage";

describe("deferredStorage", () => {
  it("coalesces rapid writes, exposes pendingValue, and flushes cleanly", () => {
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
});
