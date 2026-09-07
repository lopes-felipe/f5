import { useEffect, useRef, useState } from "react";
import type { PrHubReplyDraft, PullRequestKey } from "@t3tools/contracts";
import { ensureNativeApi } from "../../nativeApi";

/** A single writer per editor; a newer window's version always stops autosave. */
export function usePrReplyDraft(input: {
  key: PullRequestKey;
  threadId: string;
  accountGeneration: string | undefined;
  comparisonVersion: string;
  initial: PrHubReplyDraft | null;
}) {
  const [body, setBodyState] = useState(input.initial?.body ?? "");
  const [savedBody, setSavedBody] = useState(body);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const state = useRef({
    body,
    savedBody: body,
    version: input.initial?.version ?? 0,
    running: null as Promise<void> | null,
    failed: false,
    conflict: false,
  });
  const latestInput = useRef(input);
  latestInput.current = input;
  function flush(): Promise<void> {
    const current = state.current;
    if (current.running) return current.running;
    if (current.failed || current.body === current.savedBody) return Promise.resolve();
    setSaving(true);
    current.running = (async () => {
      try {
        while (current.body !== current.savedBody && !current.failed) {
          const next = current.body;
          const { initial: _, ...owner } = latestInput.current;
          const result = await ensureNativeApi().prHub.saveReplyDraft({
            ...owner,
            body: next,
            expectedVersion: current.version,
          });
          if (result.status !== "saved" || !result.draft) {
            current.failed = true;
            current.conflict = true;
            setError(
              "Another window changed this reply draft. Your text is preserved here; copy it before reloading the saved draft.",
            );
            break;
          }
          current.version = result.draft.version;
          current.savedBody = next;
          setSavedBody(next);
        }
      } catch (cause) {
        current.failed = true;
        setError(cause instanceof Error ? cause.message : "Reply draft could not be saved.");
      } finally {
        current.running = null;
        setSaving(false);
      }
    })();
    return current.running;
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const timer = setTimeout(() => void flushRef.current(), 300);
    return () => clearTimeout(timer);
  }, [body]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (state.current.body !== state.current.savedBody) event.preventDefault();
    };
    window.addEventListener("beforeunload", protect);
    return () => {
      window.removeEventListener("beforeunload", protect);
      void flushRef.current();
    };
  }, []);
  return {
    body,
    saved: body === savedBody && !error,
    saving,
    error,
    canRetry: Boolean(error) && !state.current.conflict,
    retry: () => {
      state.current.failed = false;
      setError(null);
      return flush();
    },
    flush,
    setBody: (value: string) => {
      state.current.body = value;
      setBodyState(value);
    },
  };
}
