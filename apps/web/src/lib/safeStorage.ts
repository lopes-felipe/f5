import type { StateStorage } from "zustand/middleware";

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    if (
      !storage ||
      typeof storage.getItem !== "function" ||
      typeof storage.setItem !== "function" ||
      typeof storage.removeItem !== "function"
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

export function safeLocalStorageGetItem(key: string): string | null {
  const storage = getLocalStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function safeLocalStorageSetItem(key: string, value: string): boolean {
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeLocalStorageRemoveItem(key: string): boolean {
  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads `primaryKey`, falling back to `legacyKey` on first read and copying the
 * legacy value forward to `primaryKey` (best-effort) while leaving `legacyKey`
 * readable if a user rolls back before clearing storage.
 */
export function safeLocalStorageGetMigrated(primaryKey: string, legacyKey: string): string | null {
  const current = safeLocalStorageGetItem(primaryKey);
  if (current !== null) return current;
  const legacy = safeLocalStorageGetItem(legacyKey);
  if (legacy !== null) {
    safeLocalStorageSetItem(primaryKey, legacy);
  }
  return legacy;
}

/**
 * Shared Zustand `StateStorage` wrapper backed by `safeStorage` helpers, with
 * optional silent one-way read migration from a legacy `t3code:*` storage key.
 * Removing a key also clears the legacy alias so `clearStorage()` does not
 * resurrect stale legacy state on the next read.
 */
export function createSafeZustandStorage(legacyKey?: string): StateStorage {
  return {
    getItem: (name) =>
      legacyKey ? safeLocalStorageGetMigrated(name, legacyKey) : safeLocalStorageGetItem(name),
    setItem: (name, value) => {
      safeLocalStorageSetItem(name, value);
    },
    removeItem: (name) => {
      safeLocalStorageRemoveItem(name);
      if (legacyKey) safeLocalStorageRemoveItem(legacyKey);
    },
  };
}
