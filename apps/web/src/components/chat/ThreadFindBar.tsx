import type { ThreadId, ThreadSearchResult } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { ensureNativeApi } from "../../nativeApi";
import { Button } from "../ui/button";

export type ThreadFindMatch = NonNullable<ThreadSearchResult["match"]> & { query: string };
export function ThreadFindBar({
  threadId,
  onMatch,
  onClose,
}: {
  threadId: ThreadId;
  onMatch: (match: ThreadFindMatch | null, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<ThreadSearchResult | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    setResult(null);
    setFailed(false);
    setPending(Boolean(query.trim()));
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (!query.trim()) {
        void onMatchRef.current(null, controller.signal);
        return;
      }
      void ensureNativeApi()
        .orchestration.searchThread({ threadId, query, index })
        .then(async (next) => {
          if (!current) return;
          await onMatchRef.current(next.match ? { ...next.match, query } : null, controller.signal);
          if (!current) return;
          setResult(next);
          setPending(false);
        })
        .catch(() => {
          if (!current) return;
          setPending(false);
          setFailed(true);
        });
    }, 180);
    return () => {
      current = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [threadId, query, index, retry]);
  const move = (delta: number) => {
    if (!result?.totalMatches) return;
    setIndex((result.activeIndex + delta + result.totalMatches) % result.totalMatches);
  };
  return (
    <div
      role="search"
      aria-label="Find in thread"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          move(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <input
        ref={input}
        aria-label="Find in thread"
        placeholder="Find messages and plans…"
        maxLength={512}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        className="min-w-32 flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
      />
      <span role="status" className="text-xs text-muted-foreground">
        {pending
          ? "Searching…"
          : failed
            ? "Search failed"
            : result
              ? `${result.totalMatches ? result.activeIndex + 1 : 0} of ${result.totalMatches}`
              : ""}
      </span>
      {failed ? (
        <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
          Retry
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        aria-label="Previous match"
        disabled={!result?.totalMatches || pending}
        onClick={() => move(-1)}
      >
        ↑
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Next match"
        disabled={!result?.totalMatches || pending}
        onClick={() => move(1)}
      >
        ↓
      </Button>
      <Button size="sm" variant="ghost" aria-label="Close find" onClick={onClose}>
        ×
      </Button>
      {result?.match ? (
        <p
          className="basis-full truncate text-xs text-muted-foreground"
          title={result.match.snippet}
        >
          {result.match.snippet}
        </p>
      ) : null}
    </div>
  );
}
