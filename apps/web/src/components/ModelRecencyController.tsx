import { ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resolveShortcutBinding } from "../keybindings";
import { isTerminalFocused } from "../lib/terminalFocus";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import {
  recordModelSelection,
  useModelPreferencesStore,
  wrapProviderModelOptions,
} from "../modelPreferencesStore";
import { useStore } from "../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { isWsInteractionBlocked, useWsConnectionState } from "../wsConnectionState";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/**
 * Apply the "switch to previous model" step: read the MRU, push the previous
 * selection onto the composer draft for `threadId`, and re-record it so the
 * next invocation swaps back. Returns `true` when a swap happened.
 *
 * No-ops when the thread has already started and the previous MRU entry's
 * provider differs from the thread's locked provider — the server session is
 * bound to a single provider, so a cross-provider swap cannot be honored.
 * Mirrors the `lockedProvider` guard in `ChatView.onProviderModelSelect`.
 *
 * Exported for unit testing — the controller is a thin keydown wrapper over
 * this helper.
 */
export function applyRecentModelSwap(threadId: ThreadId): boolean {
  const { recentModelSelections } = useModelPreferencesStore.getState();
  if (recentModelSelections.length < 2) {
    return false;
  }
  const previous = recentModelSelections[1];
  if (!previous) {
    return false;
  }

  // Cross-provider swaps are forbidden once the thread has started. The
  // session is pinned to one provider (codex vs claudeAgent) and cannot be
  // hot-swapped. Keep `hasThreadStarted` / `lockedProvider` in sync with the
  // derivation in `ChatView.tsx` (search: `lockedProvider: ProviderKind`).
  const thread = useStore.getState().threads.find((t) => t.id === threadId) ?? null;
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  const hasThreadStarted = Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
  const lockedProvider = hasThreadStarted
    ? (thread?.session?.provider ?? draft?.provider ?? null)
    : null;
  if (lockedProvider !== null && previous.provider !== lockedProvider) {
    return false;
  }

  const wrappedOptions = wrapProviderModelOptions(previous.provider, previous.options);
  const draftStore = useComposerDraftStore.getState();
  draftStore.setProvider(threadId, previous.provider);
  draftStore.setModel(threadId, previous.model);
  draftStore.setModelOptions(threadId, wrappedOptions);

  // Re-record the previous selection as the most-recent entry so the next
  // press swaps back to what was active before this call.
  recordModelSelection(previous.provider, previous.model, wrappedOptions);
  return true;
}

function currentTerminalOpen(threadId: ThreadId | null): boolean {
  if (!threadId) return false;
  return selectThreadTerminalState(
    useTerminalStateStore.getState().terminalStateByThreadId,
    threadId,
  ).terminalOpen;
}

/**
 * Listens for the `model.switchRecent` keybinding (default `option+tab`) and
 * swaps the active composer draft between the two most-recent model
 * selections tracked by `modelPreferencesStore.recentModelSelections`.
 *
 * Mirrors the single-press half of `ThreadRecencyController`: capture-phase
 * keydown, `consumeEvent` on match, suppressed when the ws connection is
 * blocking interaction. There is no hold-to-cycle picker here — the MRU is
 * capped at length 2 by design, so a press always targets `entries[1]`.
 */
export default function ModelRecencyController() {
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const wsConnectionState = useWsConnectionState();
  const wsInteractionBlocked = isWsInteractionBlocked(wsConnectionState.phase);

  const keybindingsRef = useRef(keybindings);
  const routeThreadIdRef = useRef(routeThreadId);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

  useEffect(() => {
    routeThreadIdRef.current = routeThreadId;
  }, [routeThreadId]);

  useEffect(() => {
    const consumeEvent = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (wsInteractionBlocked) return;

      const binding = resolveShortcutBinding(event, keybindingsRef.current, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: currentTerminalOpen(routeThreadIdRef.current),
        },
      });
      if (!binding || binding.command !== "model.switchRecent") {
        return;
      }

      const threadId = routeThreadIdRef.current;
      // Always consume so the browser doesn't fall back to tab-focus behavior
      // on `option+tab`, regardless of whether a swap is possible.
      consumeEvent(event);
      if (!threadId) {
        return;
      }
      applyRecentModelSwap(threadId);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [wsInteractionBlocked]);

  return null;
}
