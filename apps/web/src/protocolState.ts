import { useSyncExternalStore } from "react";
import {
  F5_PROTOCOL_HEADER,
  F5_PROTOCOL_VERSION,
  F5_UPGRADE_REQUIRED_MESSAGE,
  type ServerBootstrap,
  type ProviderKind,
} from "@t3tools/contracts";

let bootstrap: ServerBootstrap | null = null;
let state = { upgradeRequired: false, activeUploads: 0 };
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
}
export function getServerSendLimits(provider?: ProviderKind) {
  if (!bootstrap) throw new Error("Waiting for server capabilities. Reconnect before sending.");
  return provider ? bootstrap.providerSendLimits[provider] : bootstrap.sendLimits;
}
export function resetProtocolStateForTests(): void {
  bootstrap = null;
  state = { upgradeRequired: false, activeUploads: 0 };
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

export function reloadForProtocolUpgrade(): void {
  if (state.upgradeRequired && state.activeUploads === 0) window.location.reload();
}
