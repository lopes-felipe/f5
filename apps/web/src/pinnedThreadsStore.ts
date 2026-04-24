/**
 * Lightweight localStorage-backed set of pinned thread IDs.
 *
 * Pinning is a purely client-side preference (no backend involvement): users
 * can mark up to `MAX_PINNED_THREADS` threads to surface at the top of the
 * Home page. We keep this separate from `appSettings` because pins are a
 * collection that mutates frequently and don't belong in the Effect-schema
 * ceremony of the settings store.
 *
 * Limits exist so the Home page doesn't turn into a long list of pinned
 * items — pinning should remain a focused, "top 1–5" affordance.
 */

import type { ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "t3code:pinned-threads:v1";
export const MAX_PINNED_THREADS = 5;

type Listener = () => void;

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function readFromStorage(): ReadonlyArray<ThreadId> {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter to strings and cast to ThreadId — we defensively validate
    // because localStorage can be corrupted by the user or other tabs.
    return parsed
      .filter((value): value is ThreadId => typeof value === "string")
      .slice(0, MAX_PINNED_THREADS) as ReadonlyArray<ThreadId>;
  } catch {
    return [];
  }
}

function writeToStorage(ids: ReadonlyArray<ThreadId>): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // localStorage can fail when disabled or over-quota; swallow since
    // pinning is an optional enhancement, not critical UX.
  }
}

// Single global state + listener set. Using a manual pub/sub keeps the module
// tiny and avoids pulling zustand in for what is effectively a list of IDs.
let pinnedIds: ReadonlyArray<ThreadId> = readFromStorage();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getPinnedThreadIds(): ReadonlyArray<ThreadId> {
  return pinnedIds;
}

export function isPinned(threadId: ThreadId): boolean {
  return pinnedIds.includes(threadId);
}

export function pinThread(threadId: ThreadId): void {
  if (pinnedIds.includes(threadId)) return;
  // Insert at the head so the most-recently-pinned shows first — mirrors how
  // users think of "I just pinned this, where is it?".
  const next = [threadId, ...pinnedIds].slice(0, MAX_PINNED_THREADS);
  pinnedIds = next;
  writeToStorage(next);
  emit();
}

export function unpinThread(threadId: ThreadId): void {
  if (!pinnedIds.includes(threadId)) return;
  const next = pinnedIds.filter((id) => id !== threadId);
  pinnedIds = next;
  writeToStorage(next);
  emit();
}

export function togglePinned(threadId: ThreadId): void {
  if (pinnedIds.includes(threadId)) {
    unpinThread(threadId);
  } else {
    pinThread(threadId);
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Cross-tab sync: update in-memory state when another tab writes the key.
if (isBrowser()) {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    pinnedIds = readFromStorage();
    emit();
  });
}

export function usePinnedThreadIds(): ReadonlyArray<ThreadId> {
  return useSyncExternalStore(
    subscribe,
    () => pinnedIds,
    // Server snapshot: pins are purely client-side, so return an empty array
    // during SSR so nothing appears pinned on first paint — matching what the
    // client will show until localStorage rehydrates.
    () => [],
  );
}

export function canPinMore(current: ReadonlyArray<ThreadId>): boolean {
  return current.length < MAX_PINNED_THREADS;
}

// Test-only reset helper to keep unit tests isolated from module-level state.
export function __resetPinnedThreadsForTests(): void {
  pinnedIds = [];
  writeToStorage([]);
  emit();
}
