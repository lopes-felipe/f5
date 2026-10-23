import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";
import type { UsageSearchPatch } from "../../lib/usageSearch";

const USAGE_SHORTCUT_PATCHES: Readonly<Record<string, UsageSearchPatch>> = {
  "usage.tokens": { tab: "activity", metric: "tokens" },
  "usage.cost": { tab: "activity", metric: "cost" },
  "usage.turns": { tab: "activity", metric: "turns" },
  "usage.limits": { tab: "limits" },
  "usage.period.day": { range: "24h" },
  "usage.period.week": { range: "7d" },
  "usage.period.month": { range: "30d" },
  "usage.period.quarter": { range: "90d" },
};

/** Typing, dialogs and open popups keep their keys. */
function keepsKeys(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot$="popup"]',
      ) !== null)
  );
}

/** The Usage view change a page shortcut asks for, or null. */
export function resolveUsageShortcut(
  event: ShortcutEventLike & { readonly target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): UsageSearchPatch | null {
  if (keepsKeys(event.target)) return null;
  const command = resolveShortcutCommand(event, keybindings, {
    ...(platform ? { platform } : {}),
    context: { usagePageOpen: true },
  });
  return command ? (USAGE_SHORTCUT_PATCHES[command] ?? null) : null;
}

/** Escape leaves Usage unless something on the page is using it. */
export function isUsageBackShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    readonly target: EventTarget | null;
    readonly defaultPrevented: boolean;
  },
): boolean {
  if (event.defaultPrevented || event.key !== "Escape") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return !keepsKeys(event.target);
}
