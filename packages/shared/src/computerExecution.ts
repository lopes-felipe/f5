import type {
  ComputerAutomationOperation,
  ComputerDelivery,
  ComputerElementAction,
  ComputerLeaseScope,
} from "@t3tools/contracts";
import { integrationBrowserBundleIds } from "./providerIntegrationCertification";

export function computerHostMetadata(platform: string): {
  hostPlatform?: "darwin" | "win32";
  stopShortcut?: string;
} {
  return platform === "win32"
    ? { hostPlatform: platform, stopShortcut: "Ctrl+Alt+Shift+F12" }
    : platform === "darwin"
      ? { hostPlatform: platform, stopShortcut: "⌃⌘Esc" }
      : {};
}

/**
 * Accessibility operations available in background generations. Process-directed key/scroll
 * events additionally require negotiated support and an app certified for those events.
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
  options: { events?: boolean } = {},
): boolean {
  if (op === "key" || op === "scroll") return options.events === true;
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
 * are exclusive among foreground holders; capable helpers may share background app scopes.
 */
export function computerScopesConflict(
  requested: ComputerLeaseScope,
  held: ComputerLeaseScope,
  options: { shareApps?: boolean } = {},
): boolean {
  if (requested.kind === "foreground" || held.kind === "foreground") return true;
  if (requested.kind === "takeover" && held.kind === "takeover") return true;
  if (options.shareApps && requested.kind === "app" && held.kind === "app") return false;
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
  options: { events?: boolean } = {},
): boolean {
  if (delivery === "background")
    return (
      scope.kind === "app" &&
      appId === scope.appId &&
      op !== "activateApp" &&
      computerBackgroundOpAllowed(op, action, options)
    );
  if (scope.kind === "foreground") return true;
  if (scope.kind === "app") return false;
  return appId === undefined || appId === scope.appId;
}
/** These shortcuts are handled by the desktop session, regardless of a target process. */
export function computerBackgroundKeyAllowed(
  chords: ReadonlyArray<string>,
  platform: "darwin" | "win32",
): boolean {
  if (!chords.length) return false;
  return chords.every((raw) => {
    const parts = raw
      .toLowerCase()
      .split("+")
      .map((part) => part.trim());
    const key = parts.at(-1) ?? "";
    const has = (...names: string[]) => names.some((name) => parts.includes(name));
    const control = has("control", "ctrl");
    const alt = has("alt", "option", "opt");
    const meta = has("meta", "command", "cmd", "win", "windows", "super");
    const escape = key === "escape" || key === "esc";
    if (platform === "win32")
      return (
        !meta &&
        !(alt && key === "tab") &&
        !(control && ((alt && (key === "delete" || key === "del")) || escape))
      );
    return (
      !(meta && (key === "tab" || key === "space")) &&
      !(
        control &&
        ["up", "down", "left", "right", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(
          key,
        )
      ) &&
      !(meta && alt && escape) &&
      !(meta && control && key === "q") &&
      !(meta && has("shift") && ["3", "4", "5"].includes(key))
    );
  });
}
