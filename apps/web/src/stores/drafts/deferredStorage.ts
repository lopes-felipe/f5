import { Debouncer } from "@tanstack/react-pacer";
import type { StateStorage } from "zustand/middleware";

import { COMPOSER_DRAFT_PERSISTENCE_ERROR_EVENT } from "../../composerDraftStore";

export const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

/**
 * Debounced writes over a string storage. `setItem` keeps only a reference to
 * the latest value per name; `serialize` runs when that name's debounce fires
 * (or on `flush` / `pendingValue`), so rapid edits cost one serialization per
 * window instead of one per keystroke.
 */
export interface DeferredStorage<T> {
  /** The stored string, without any pending write applied. */
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: T) => void;
  removeItem: (name: string) => void;
  cancelPending: () => void;
  flush: () => void;
  /** Serialized pending value for `name` (default: the last name written), if any. */
  pendingValue: (name?: string) => string | null;
}

export interface PendingWrite<T> {
  readonly debouncer: Debouncer<() => void>;
  latest: { readonly value: T } | null;
  serialized: { readonly value: T; readonly text: string } | null;
}

export function createDeferredStorage<T>(
  baseStorage: StateStorage,
  serialize: (value: T) => string,
): DeferredStorage<T> {
  const pendingByName = new Map<string, PendingWrite<T>>();
  let lastName: string | null = null;
  const reportWriteFailure = (error: unknown) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(COMPOSER_DRAFT_PERSISTENCE_ERROR_EVENT, {
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  const serializePending = (pending: PendingWrite<T>): string | null => {
    const latest = pending.latest;
    if (!latest) return null;
    if (pending.serialized?.value !== latest.value) {
      pending.serialized = { value: latest.value, text: serialize(latest.value) };
    }
    return pending.serialized.text;
  };
  const write = (name: string) => {
    const pending = pendingByName.get(name);
    if (!pending?.latest) return;
    try {
      const text = serializePending(pending);
      pending.latest = null;
      pending.serialized = null;
      if (text === null) return;
      const result = baseStorage.setItem(name, text);
      if (result instanceof Promise) {
        void result.catch(reportWriteFailure);
      }
    } catch (error) {
      pending.latest = null;
      pending.serialized = null;
      reportWriteFailure(error);
    }
  };
  const pendingFor = (name: string): PendingWrite<T> => {
    let pending = pendingByName.get(name);
    if (!pending) {
      pending = {
        debouncer: new Debouncer(() => write(name), { wait: COMPOSER_PERSIST_DEBOUNCE_MS }),
        latest: null,
        serialized: null,
      };
      pendingByName.set(name, pending);
    }
    return pending;
  };
  const cancel = (pending: PendingWrite<T>) => {
    pending.debouncer.cancel();
    pending.latest = null;
    pending.serialized = null;
  };

  return {
    getItem: (name) => baseStorage.getItem(name),
    setItem: (name, value) => {
      lastName = name;
      const pending = pendingFor(name);
      pending.latest = { value };
      pending.debouncer.maybeExecute();
    },
    removeItem: (name) => {
      const pending = pendingByName.get(name);
      if (pending) cancel(pending);
      baseStorage.removeItem(name);
    },
    cancelPending: () => {
      for (const pending of pendingByName.values()) cancel(pending);
    },
    flush: () => {
      for (const pending of pendingByName.values()) pending.debouncer.flush();
    },
    pendingValue: (name) => {
      const target = name ?? lastName;
      const pending = target === null ? undefined : pendingByName.get(target);
      if (!pending) return null;
      try {
        return serializePending(pending);
      } catch {
        return null;
      }
    },
  };
}

/** String-valued deferred storage (serialization is the identity). */
export function createDebouncedStorage(baseStorage: StateStorage): DeferredStorage<string> {
  return createDeferredStorage<string>(baseStorage, (value) => value);
}

export function createMemoryStateStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(value: unknown): value is StateStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    "getItem" in value &&
    typeof value.getItem === "function" &&
    "setItem" in value &&
    typeof value.setItem === "function" &&
    "removeItem" in value &&
    typeof value.removeItem === "function"
  );
}
