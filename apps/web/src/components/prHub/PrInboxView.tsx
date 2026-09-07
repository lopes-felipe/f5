import { useEffect, useMemo, useRef, useState } from "react";
import { GitPullRequestIcon } from "lucide-react";
import type {
  PrHubAdvisory,
  PullRequestKey,
  ThreadId,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { sourceControlPullRequestKeysEqual } from "@t3tools/shared/sourceControl";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { PrDetailPanel } from "./PrDetailPanel";
import { PrSpineList } from "./PrSpineList";
import { comparePrPriority } from "./prHubPresentation";
import { isInteractiveTextTarget } from "./prHubKeyboard";

export interface PrModeViewProps {
  prs: readonly TrackedPullRequest[];
  advisoriesByKey: Map<PullRequestKey, PrHubAdvisory>;
  analyzingKeys: ReadonlySet<PullRequestKey>;
  onAnalyzeAdvisory: (key: PullRequestKey) => void;
  onThreadCreated?: ((threadId: ThreadId) => Promise<void> | void) | undefined;
  focusedPrKey: string | null;
  onSelectionChange?: ((key: PullRequestKey) => void) | undefined;
}

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
 * Split-pane "inbox": a skinny scannable spine on the left and the full PR
 * detail on the right, one at a time. Arrow keys / j-k move the selection;
 * Enter moves focus into the detail pane.
 */
export function PrInboxView({
  prs,
  advisoriesByKey,
  analyzingKeys,
  onAnalyzeAdvisory,
  onThreadCreated,
  focusedPrKey,
  onSelectionChange,
}: PrModeViewProps) {
  const ordered = useMemo(() => [...prs].sort(comparePrPriority), [prs]);
  const [selectedKey, setSelectedKey] = useState<PullRequestKey | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  // The deep-link is honoured exactly once per distinct `focusedPrKey` value, so
  // that subsequent keyboard/mouse selection isn't snapped back to it.
  const honoredDeepLinkRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedKey) onSelectionChange?.(selectedKey);
  }, [selectedKey, onSelectionChange]);

  const selectedIndex = ordered.findIndex((pr) => pr.key === selectedKey);

  // Resolve the selection in a single effect (so the deep-link and the
  // first-row fallback can't race each other on mount): honour a deep-link once
  // per distinct value when its PR is present, otherwise keep a valid selection.
  useEffect(() => {
    if (!focusedPrKey) honoredDeepLinkRef.current = null;
    if (ordered.length === 0) {
      if (selectedKey !== null) setSelectedKey(null);
      return;
    }
    if (focusedPrKey && honoredDeepLinkRef.current !== focusedPrKey) {
      const match = ordered.find((pr) => sourceControlPullRequestKeysEqual(pr.key, focusedPrKey));
      if (match) {
        honoredDeepLinkRef.current = focusedPrKey;
        setSelectedKey(match.key);
        return;
      }
    }
    if (!ordered.some((pr) => pr.key === selectedKey)) {
      setSelectedKey(ordered[0]!.key);
    }
  }, [ordered, focusedPrKey, selectedKey]);

  useEffect(() => {
    function move(delta: number) {
      const current = ordered.findIndex((pr) => pr.key === selectedKey);
      const base = current < 0 ? 0 : current;
      const next = Math.min(Math.max(base + delta, 0), ordered.length - 1);
      setSelectedKey(ordered[next]!.key);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (isInteractiveTextTarget() || event.metaKey || event.ctrlKey || event.altKey) return;
      if (ordered.length === 0) return;
      const active = document.activeElement;
      const inDetail = Boolean(active && detailRef.current?.contains(active));
      switch (event.key) {
        case "j":
          event.preventDefault();
          move(1);
          break;
        case "k":
          event.preventDefault();
          move(-1);
          break;
        case "ArrowDown":
          // Let the focused detail pane scroll; arrows only navigate the spine.
          if (inDetail) return;
          event.preventDefault();
          move(1);
          break;
        case "ArrowUp":
          if (inDetail) return;
          event.preventDefault();
          move(-1);
          break;
        case "Enter":
          // Only hijack Enter from a spine row, so buttons/filters/toggles keep
          // their normal activation.
          if (active?.closest('[role="listbox"]')) {
            event.preventDefault();
            detailRef.current?.focus();
          }
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ordered, selectedKey]);

  const selectedPr = selectedIndex >= 0 ? ordered[selectedIndex] : null;
  const selectedAdvisory = selectedPr ? advisoriesByKey.get(selectedPr.key) : undefined;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-e">
        <PrSpineList prs={ordered} selectedKey={selectedKey} onSelect={setSelectedKey} />
        <footer className="hidden shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground lg:flex">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
        </footer>
      </div>

      <div
        ref={detailRef}
        tabIndex={-1}
        className="min-h-0 overflow-y-auto p-5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/35"
      >
        {selectedPr ? (
          <PrDetailPanel
            key={selectedPr.key}
            pr={selectedPr}
            advisory={selectedAdvisory}
            isAnalyzingAdvisory={isAnalyzing(selectedPr, analyzingKeys, selectedAdvisory)}
            onAnalyzeAdvisory={() => onAnalyzeAdvisory(selectedPr.key)}
            onThreadCreated={onThreadCreated}
          />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GitPullRequestIcon />
              </EmptyMedia>
              <EmptyTitle>No pull requests</EmptyTitle>
              <EmptyDescription>No entries match this filter.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
