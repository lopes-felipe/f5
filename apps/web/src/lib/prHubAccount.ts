import { useSyncExternalStore } from "react";

/** The current server-verified account incarnation; credentials never enter this store. */
let generation: string | undefined;
let account: { host: string; viewerId: number | string; generation: string } | undefined;
let selectedAccountId: string | undefined;

interface PrHubAccountSnapshot {
  readonly accountId: string | undefined;
  readonly generation: string | undefined;
}

let snapshot: PrHubAccountSnapshot = { accountId: undefined, generation: undefined };
const listeners = new Set<() => void>();

function notifyListeners(): void {
  if (snapshot.accountId === selectedAccountId && snapshot.generation === generation) return;
  snapshot = { accountId: selectedAccountId, generation };
  for (const listener of listeners) listener();
}

export function subscribePrHubAccount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPrHubAccountSnapshot(): PrHubAccountSnapshot {
  return snapshot;
}

export function usePrHubAccountSnapshot(): PrHubAccountSnapshot {
  return useSyncExternalStore(
    subscribePrHubAccount,
    getPrHubAccountSnapshot,
    getPrHubAccountSnapshot,
  );
}

export function setPrHubAccount(value: typeof account): void {
  account = value;
  generation = value?.generation;
  notifyListeners();
}

/** Stable draft ownership survives credential replacement and server restart. */
export function getPrHubDraftIdentity(): readonly [string, number | string] | undefined {
  return account?.generation === generation && account
    ? [account.host, account.viewerId]
    : undefined;
}

export function getPrHubAccountGeneration(): string | undefined {
  return generation;
}

export function setPrHubAccountGeneration(value: string | undefined): void {
  generation = value;
  notifyListeners();
}

export function assertPrHubAccountGeneration(expected: string | undefined): void {
  if (generation !== expected) {
    throw new Error("The GitHub account changed. Refresh PR Hub before continuing.");
  }
}

export function getPrHubSelectedAccountId(): string | undefined {
  return selectedAccountId;
}
export function setPrHubSelectedAccountId(value: string | undefined): void {
  if (selectedAccountId === value) return;
  selectedAccountId = value;
  setPrHubAccount(undefined);
}
