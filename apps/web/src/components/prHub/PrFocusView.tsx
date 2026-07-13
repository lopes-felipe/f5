import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCheckIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { PrHubAdvisory, PullRequestKey, TrackedPullRequest } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { PrDetailPanel, type PrDetailHandle } from "./PrDetailPanel";
import type { PrModeViewProps } from "./PrInboxView";
import { comparePrPriority } from "./prHubPresentation";
import { isInteractiveTextTarget } from "./prHubKeyboard";

function isAnalyzing(
  pr: TrackedPullRequest,
  analyzingKeys: ReadonlySet<PullRequestKey>,
  advisory: PrHubAdvisory | undefined,
): boolean {
  return (
    analyzingKeys.has(pr.key) || advisory?.status === "queued" || advisory?.status === "running"
  );
}

/**
 * One-at-a-time triage queue. Steps through the active filter ordered by
 * priority; Prev/Next (← → / p n) walk the queue, a/s/e fire the primary
 * action / snooze / ignore. Acting on a PR removes it from the snapshot, which
 * naturally surfaces the next item — burning the queue down to "caught up".
 */
export function PrFocusView({
  prs,
  advisoriesByKey,
  analyzingKeys,
  onAnalyzeAdvisory,
  onThreadCreated,
  focusedPrKey,
}: PrModeViewProps) {
  const ordered = useMemo(() => [...prs].sort(comparePrPriority), [prs]);
  const [index, setIndex] = useState(0);
  const detailHandleRef = useRef<PrDetailHandle | null>(null);
  // The deep-link is honoured exactly once per distinct `focusedPrKey` value, so
  // that Prev/Next (and n/p) aren't snapped back to it.
  const honoredDeepLinkRef = useRef<string | null>(null);

  // Jump to a deep-linked PR once, when it is present in the queue.
  useEffect(() => {
    if (!focusedPrKey) {
      honoredDeepLinkRef.current = null;
      return;
    }
    if (honoredDeepLinkRef.current === focusedPrKey) return;
    const deepLinked = ordered.findIndex((pr) => pr.key === focusedPrKey);
    if (deepLinked < 0) return;
    honoredDeepLinkRef.current = focusedPrKey;
    setIndex(deepLinked);
  }, [focusedPrKey, ordered]);

  // Clamp the cursor when the queue shrinks (e.g. after acting on a PR).
  useEffect(() => {
    if (ordered.length === 0) {
      if (index !== 0) setIndex(0);
      return;
    }
    if (index > ordered.length - 1) {
      setIndex(ordered.length - 1);
    }
  }, [ordered, index]);

  const safeIndex = ordered.length === 0 ? -1 : Math.min(index, ordered.length - 1);
  const currentPr = safeIndex >= 0 ? ordered[safeIndex] : null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isInteractiveTextTarget() || event.metaKey || event.ctrlKey || event.altKey) return;
      if (ordered.length === 0) return;
      switch (event.key) {
        case "ArrowRight":
        case "n":
          event.preventDefault();
          setIndex((current) => Math.min(current + 1, ordered.length - 1));
          break;
        case "ArrowLeft":
        case "p":
          event.preventDefault();
          setIndex((current) => Math.max(current - 1, 0));
          break;
        case "a":
          event.preventDefault();
          detailHandleRef.current?.triggerPrimary();
          break;
        case "s":
          event.preventDefault();
          detailHandleRef.current?.triggerSnooze();
          break;
        case "e":
          event.preventDefault();
          detailHandleRef.current?.triggerIgnore();
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ordered]);

  if (!currentPr) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCheckIcon />
            </EmptyMedia>
            <EmptyTitle>You&apos;re all caught up</EmptyTitle>
            <EmptyDescription>Nothing in this queue needs you right now.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const advisory = advisoriesByKey.get(currentPr.key);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {safeIndex + 1} of {ordered.length}
        </span>
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-1 sm:flex">
            <Kbd>a</Kbd> action
            <Kbd>s</Kbd> snooze
            <Kbd>e</Kbd> ignore
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Previous"
              disabled={safeIndex <= 0}
              onClick={() => setIndex((current) => Math.max(current - 1, 0))}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Next"
              disabled={safeIndex >= ordered.length - 1}
              onClick={() => setIndex((current) => Math.min(current + 1, ordered.length - 1))}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl p-6">
          <PrDetailPanel
            key={currentPr.key}
            ref={detailHandleRef}
            pr={currentPr}
            advisory={advisory}
            isAnalyzingAdvisory={isAnalyzing(currentPr, analyzingKeys, advisory)}
            onAnalyzeAdvisory={() => onAnalyzeAdvisory(currentPr.key)}
            onThreadCreated={onThreadCreated}
          />
        </div>
      </div>
    </div>
  );
}
