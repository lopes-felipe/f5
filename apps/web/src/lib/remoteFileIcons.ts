import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import type { ServerConfig } from "@t3tools/contracts";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { serverQueryKeys } from "./serverReactQuery";

/**
 * Whether file icons may load from the jsDelivr CDN. Until the server's config has arrived
 * the answer is no, since it may run with `DO_NOT_TRACK`. A server too old to report
 * `privacy` predates that switch, so its config allows remote icons.
 */
export function remoteFileIconsAllowed(config: ServerConfig | undefined): boolean {
  return config !== undefined && config.privacy?.doNotTrack !== true;
}

const CONFIG_KEY = serverQueryKeys.config();
const isConfigKey = (key: ReadonlyArray<unknown>) =>
  key.length === CONFIG_KEY.length && CONFIG_KEY.every((part, index) => key[index] === part);

interface IconPolicyStore {
  value: boolean;
  readonly listeners: Set<() => void>;
  unsubscribe: (() => void) | undefined;
}

// One query-cache subscription per client, shared by every icon. Icons re-render only when
// the config query changes the answer, not on every cache event.
const stores = new WeakMap<QueryClient, IconPolicyStore>();

function storeFor(client: QueryClient): IconPolicyStore {
  let store = stores.get(client);
  if (!store) {
    store = { value: false, listeners: new Set(), unsubscribe: undefined };
    stores.set(client, store);
  }
  return store;
}

function readConfigPolicy(client: QueryClient): boolean {
  return remoteFileIconsAllowed(client.getQueryData<ServerConfig>(CONFIG_KEY));
}

function subscribeToIconPolicy(client: QueryClient, listener: () => void): () => void {
  const store = storeFor(client);
  store.listeners.add(listener);
  if (!store.unsubscribe) {
    store.value = readConfigPolicy(client);
    store.unsubscribe = client.getQueryCache().subscribe((event) => {
      if (!isConfigKey(event.query.queryKey)) return;
      const next = remoteFileIconsAllowed(event.query.state.data as ServerConfig | undefined);
      if (next === store.value) return;
      store.value = next;
      for (const notify of store.listeners) notify();
    });
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.unsubscribe?.();
      store.unsubscribe = undefined;
    }
  };
}

function iconPolicySnapshot(client: QueryClient): boolean {
  const store = storeFor(client);
  // Without a live subscription the cached value may be stale; read the cache directly.
  return store.unsubscribe ? store.value : readConfigPolicy(client);
}

/**
 * Reads the cached server config without starting a fetch of its own: the app loads that
 * config at startup. Renders outside a QueryClient have no server to ask and stay local.
 */
export function useRemoteFileIconsEnabled(): boolean {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => (client ? subscribeToIconPolicy(client, onChange) : () => {}),
    [client],
  );
  const read = () => (client ? iconPolicySnapshot(client) : false);
  return useSyncExternalStore(subscribe, read, read);
}
