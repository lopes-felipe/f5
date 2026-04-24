import * as Schema from "effect/Schema";

import { getLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";

const NullableBoolean = Schema.NullOr(Schema.Boolean);

export const WEB_LOCAL_FLAG_KEYS = {
  slowRpcWarningEnabled: "t3code.slowRpcWarningEnabled",
  wsDisconnectSurfaceEnabled: "t3code.wsDisconnectSurfaceEnabled",
} as const;

const WEB_LOCAL_FLAG_DEFAULTS = {
  slowRpcWarningEnabled: false,
  wsDisconnectSurfaceEnabled: false,
} as const;

type WebLocalFlagName = keyof typeof WEB_LOCAL_FLAG_KEYS;

function resolveWebLocalFlag(name: WebLocalFlagName, override: boolean | null): boolean {
  return override ?? WEB_LOCAL_FLAG_DEFAULTS[name];
}

function useWebLocalFlag(name: WebLocalFlagName): boolean {
  const [override] = useLocalStorage(WEB_LOCAL_FLAG_KEYS[name], null, NullableBoolean);

  return resolveWebLocalFlag(name, override);
}

export function getWebLocalFlag(name: WebLocalFlagName): boolean {
  return resolveWebLocalFlag(name, getLocalStorageItem(WEB_LOCAL_FLAG_KEYS[name], NullableBoolean));
}

export function useSlowRpcWarningEnabled(): boolean {
  return useWebLocalFlag("slowRpcWarningEnabled");
}

export function useWsDisconnectSurfaceEnabled(): boolean {
  return useWebLocalFlag("wsDisconnectSurfaceEnabled");
}
