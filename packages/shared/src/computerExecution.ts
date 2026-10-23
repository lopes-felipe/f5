import type {
  ComputerAutomationOperation,
  ComputerDelivery,
  ComputerElementAction,
  ComputerLeaseScope,
} from "@t3tools/contracts";
import { integrationBrowserBundleIds } from "./providerIntegrationCertification";

/**
 * Operations a background (accessibility-only) generation may execute. Everything else needs
 * the foreground: coordinate input, keys and activation reach whatever app is frontmost.
 * Mirrors `computerBackgroundOpAllowed` in the macOS helper.
 */
const BACKGROUND_OPS: ReadonlySet<ComputerAutomationOperation> = new Set([
  "status",
  "listApps",
  "resolveApps",
  "inspect",
  "screenshot",
  "zoom",
  "elementAction",
  "type",
  "openApp",
]);
const BACKGROUND_ELEMENT_ACTIONS: ReadonlySet<ComputerElementAction> = new Set([
  "press",
  "setValue",
]);
/** Ops that act inside one named app in background mode and therefore require `appId`. */
const APP_SCOPED_OPS: ReadonlySet<ComputerAutomationOperation> = new Set([
  "inspect",
  "screenshot",
  "zoom",
  "elementAction",
  "type",
  "openApp",
]);
/**
 * Every browser a provider integration registers a native-messaging host for. Native
 * control of any of them conflicts with Chrome control; background leases on other apps
 * coexist with it.
 */
export const COMPUTER_CHROME_APP_IDS: ReadonlyArray<string> = integrationBrowserBundleIds();

export function computerBackgroundOpAllowed(
  op: ComputerAutomationOperation,
  action?: ComputerElementAction,
): boolean {
  if (!BACKGROUND_OPS.has(op)) return false;
  return op !== "elementAction" || (action !== undefined && BACKGROUND_ELEMENT_ACTIONS.has(action));
}
export function computerOpRequiresApp(op: ComputerAutomationOperation): boolean {
  return APP_SCOPED_OPS.has(op);
}
export function computerScopeDelivery(scope: ComputerLeaseScope): ComputerDelivery {
  return scope.kind === "app" ? "background" : "foreground";
}
export function computerScopeAppId(scope: ComputerLeaseScope): string | undefined {
  return scope.kind === "foreground" ? undefined : scope.appId;
}
export function sameComputerScope(a: ComputerLeaseScope, b: ComputerLeaseScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "foreground") return true;
  if (a.kind === "app") return a.appId === (b as typeof a).appId;
  const other = b as typeof a;
  return a.appId === other.appId && a.approvalReceipt === other.approvalReceipt;
}
/**
 * Whether `requested` may coexist with another thread's `held` scope. Foreground and takeover
 * are exclusive among foreground holders; background leases are one agent per app.
 */
export function computerScopesConflict(
  requested: ComputerLeaseScope,
  held: ComputerLeaseScope,
): boolean {
  if (requested.kind === "foreground" || held.kind === "foreground") return true;
  if (requested.kind === "takeover" && held.kind === "takeover") return true;
  return requested.appId === held.appId;
}
/**
 * Request-level check, also enforced by the helper: background needs the matching app scope
 * and a background op; foreground needs the legacy scope or a takeover of the same app.
 */
export function computerScopeAllows(
  scope: ComputerLeaseScope,
  delivery: ComputerDelivery,
  op: ComputerAutomationOperation,
  appId: string | undefined,
  action?: ComputerElementAction,
): boolean {
  if (delivery === "background")
    return (
      scope.kind === "app" &&
      appId === scope.appId &&
      op !== "activateApp" &&
      computerBackgroundOpAllowed(op, action)
    );
  if (scope.kind === "foreground") return true;
  if (scope.kind === "app") return false;
  return appId === undefined || appId === scope.appId;
}
