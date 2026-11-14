import { WS_METHODS } from "@t3tools/contracts";

import type { ProviderAccountService } from "../../profiles/ProviderAccountService.ts";
import { routePromise, type RouteTable } from "./routeTable.ts";

type ProviderAccountMethod =
  | typeof WS_METHODS.providerAccountLoginStart
  | typeof WS_METHODS.providerAccountLogout
  | typeof WS_METHODS.providerAccountInput
  | typeof WS_METHODS.providerAccountCancel
  | typeof WS_METHODS.providerAccountStatus;

/**
 * Signing a provider instance in and out. A sign-in belongs to the socket that
 * started it: only that socket may type into it or cancel it, and its events go
 * to that socket alone.
 */
export const providerAccountRoutes = (
  accounts: Pick<ProviderAccountService, "start" | "input" | "cancel" | "status">,
): RouteTable<ProviderAccountMethod> => ({
  [WS_METHODS.providerAccountLoginStart]: ({ instanceId, method }, ws) =>
    routePromise(() => accounts.start(instanceId, false, ws, method)),
  [WS_METHODS.providerAccountLogout]: ({ instanceId }, ws) =>
    routePromise(() => accounts.start(instanceId, true, ws)),
  [WS_METHODS.providerAccountInput]: ({ handle, data }, ws) =>
    routePromise(async () => accounts.input(handle, data, ws)),
  [WS_METHODS.providerAccountCancel]: ({ handle }, ws) =>
    routePromise(() => accounts.cancel(handle, ws)),
  [WS_METHODS.providerAccountStatus]: ({ instanceId }) =>
    routePromise(() => accounts.status(instanceId)),
});
