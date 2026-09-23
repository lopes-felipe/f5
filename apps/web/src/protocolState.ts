import { useSyncExternalStore } from "react";
import {
  F5_PROTOCOL_HEADER,
  F5_PROTOCOL_VERSION,
  F5_UPGRADE_REQUIRED_MESSAGE,
  type ServerBootstrap,
} from "@t3tools/contracts";

let bootstrap: ServerBootstrap | null = null;
let state = { upgradeRequired: false, activeUploads: 0, ready: false };
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = () => {
  for (const listener of listeners) listener();
};
export const getProtocolState = () => state;
export const useProtocolState = () =>
  useSyncExternalStore(subscribe, getProtocolState, getProtocolState);
export function requireProtocolUpgrade(): void {
  if (state.upgradeRequired) return;
  state = { ...state, upgradeRequired: true };
  emit();
}
export function setServerBootstrap(value: ServerBootstrap): void {
  bootstrap = value;
  state = { ...state, ready: true };
  emit();
}
export function getServerSendLimits() {
  if (!bootstrap) throw new Error("Waiting for server capabilities. Reconnect before sending.");
  return bootstrap.sendLimits;
}
export function resetProtocolStateForTests(): void {
  bootstrap = null;
  state = { upgradeRequired: false, activeUploads: 0, ready: false };
  emit();
}

/** Track the entire upload/response lifetime so an update cannot interrupt it. */
export function beginProtocolUpload(): () => void {
  if (state.upgradeRequired) throw new Error(F5_UPGRADE_REQUIRED_MESSAGE);
  state = { ...state, activeUploads: state.activeUploads + 1 };
  emit();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    state = { ...state, activeUploads: state.activeUploads - 1 };
    emit();
  };
}

/** Every private HTTP mutation must carry the exact wire protocol version. */
export async function protocolFetch(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  if (state.upgradeRequired) throw new Error(F5_UPGRADE_REQUIRED_MESSAGE);
  const headers = new Headers(init.headers);
  headers.set(F5_PROTOCOL_HEADER, String(F5_PROTOCOL_VERSION));
  const response = await fetch(input, { ...init, headers });
  if (response.status === 426) {
    requireProtocolUpgrade();
    throw new Error(F5_UPGRADE_REQUIRED_MESSAGE);
  }
  return response;
}

const reloadAttemptKey = `f5:protocol-reload:${F5_PROTOCOL_VERSION}`;
export function canAutoReloadForProtocolUpgrade(): boolean {
  try {
    return sessionStorage.getItem(reloadAttemptKey) !== "attempted";
  } catch {
    return false;
  }
}
export function reloadForProtocolUpgrade(): void {
  if (!state.upgradeRequired || state.activeUploads > 0 || !canAutoReloadForProtocolUpgrade())
    return;
  try {
    sessionStorage.setItem(reloadAttemptKey, "attempted");
  } catch {
    return;
  }
  window.location.reload();
}
