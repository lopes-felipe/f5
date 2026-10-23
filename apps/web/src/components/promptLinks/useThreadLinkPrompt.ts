import type { ThreadId } from "@t3tools/contracts";
import { parseThreadLinkPrompt, withoutPromptLinkParams } from "@t3tools/shared/promptLinks";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { toastManager } from "../ui/toast";
import { placeLinkedPrompt } from "./linkedPrompt";

/** Whether a location pathname is this thread's own route, `/$threadId`. */
export function isThreadPathname(pathname: string, threadId: ThreadId): boolean {
  return pathname.replace(/\/$/, "") === `/${encodeURIComponent(threadId)}`;
}

/**
 * Handles `f5://thread/<id>?prompt=…`: once the thread is loaded, the prompt goes into its
 * composer and the link's parameters leave the URL so a reload does not offer it again.
 */
export function useThreadLinkPrompt(threadId: ThreadId, ready: boolean): void {
  const pathname = useLocation({ select: (location) => location.pathname });
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigate();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !new URLSearchParams(searchStr).has("prompt")) return;
    // A pending navigation already shows the next location while this thread is still mounted,
    // so a link to another screen would otherwise land here.
    if (!isThreadPathname(pathname, threadId)) return;
    const key = `${threadId}${searchStr}`;
    if (handled.current === key) return;
    handled.current = key;
    const parsed = parseThreadLinkPrompt(searchStr);
    if (!parsed.ok) {
      toastManager.add({
        type: "warning",
        title: "F5 could not open this link",
        description: parsed.error,
      });
    } else if (parsed.value !== null) {
      placeLinkedPrompt(threadId, parsed.value);
    }
    void navigate({ href: `${pathname}${withoutPromptLinkParams(searchStr)}`, replace: true });
  }, [navigate, pathname, ready, searchStr, threadId]);
}
