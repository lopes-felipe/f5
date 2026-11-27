import { useEffect, useState } from "react";

const LIVE_REGION_CLEAR_MS = 7_000;

interface LiveRegionState {
  readonly scopeKey: string;
  readonly message: string;
  /** Bumped per announcement so repeating the same text still mutates the DOM. */
  readonly sequence: number;
}

/**
 * Shared polite live-region state machine:
 * - resets silently when `scopeKey` changes (e.g. route/thread/workflow switch),
 * - toggles a trailing non-breaking space on repeated messages so screen readers
 *   announce them again,
 * - clears the text after 7 s so returning focus from a dialog never replays a
 *   stale status.
 */
export function useLiveRegionMessage(scopeKey: string) {
  const [state, setState] = useState<LiveRegionState>(() => ({
    scopeKey,
    message: "",
    sequence: 0,
  }));

  useEffect(() => {
    if (!state.message) return;
    const timer = setTimeout(() => {
      setState((current) =>
        current.scopeKey === state.scopeKey && current.sequence === state.sequence
          ? { ...current, message: "" }
          : current,
      );
    }, LIVE_REGION_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [state.message, state.sequence, state.scopeKey]);

  const reset = (nextScopeKey: string) => {
    setState({
      scopeKey: nextScopeKey,
      message: "",
      sequence: 0,
    });
  };

  const announce = (message: string) => {
    setState((current) => ({
      scopeKey,
      message,
      sequence: current.sequence + 1,
    }));
  };

  const clear = () => {
    setState((current) => (current.message ? { ...current, message: "" } : current));
  };

  const renderedMessage = state.message
    ? state.sequence % 2 === 1
      ? `${state.message}\u00A0`
      : state.message
    : "";

  return {
    scopeKey: state.scopeKey,
    renderedMessage,
    reset,
    announce,
    clear,
  };
}
