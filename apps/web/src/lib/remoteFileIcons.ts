import { QueryClientContext } from "@tanstack/react-query";
import type { ServerConfig } from "@t3tools/contracts";
import { useCallback, useContext, useSyncExternalStore } from "react";
import { serverQueryKeys } from "./serverReactQuery";

/**
 * File icons load from the jsDelivr CDN unless the server runs with `DO_NOT_TRACK`.
 * Reads the cached server config without starting a fetch of its own: the app loads
 * that config at startup, and renders outside a QueryClient keep remote icons.
 */
export function useRemoteFileIconsEnabled(): boolean {
  const client = useContext(QueryClientContext);
  const subscribe = useCallback(
    (onChange: () => void) => (client ? client.getQueryCache().subscribe(onChange) : () => {}),
    [client],
  );
  const read = () =>
    client?.getQueryData<ServerConfig>(serverQueryKeys.config())?.privacy?.doNotTrack !== true;
  return useSyncExternalStore(subscribe, read, read);
}
