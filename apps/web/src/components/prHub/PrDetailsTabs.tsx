import { resolveShortcutCommand, useServerKeybindings } from "~/keybindings";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { toastManager } from "~/components/ui/toast";
import { PrReviewThreadsTab } from "./PrReviewThreadsTab";
import { useEffect, useState, type ReactNode } from "react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { PrFilesTab } from "./PrFilesTab";
import { PrSummaryTab } from "./PrSummaryTab";
import { PrTimelineTab } from "./PrTimelineTab";
import { usePrDetailMutations } from "./usePrDetailMutations";

export type PrDetailTab = "summary" | "timeline" | "files" | "review_threads";

export function PrDetailsTabs({
  pr,
  summary,
  activeTab,
  onTabChange,
}: {
  pr: TrackedPullRequest;
  summary: ReactNode;
  activeTab?: PrDetailTab;
  onTabChange?: (tab: PrDetailTab) => void;
}) {
  const [localTab, setLocalTab] = useState<PrDetailTab>("summary");
  const keybindings = useServerKeybindings();
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable=true], [role=dialog]")) return;
      if (resolveShortcutCommand(event, keybindings) !== "prHub.copyNumber") return;
      event.preventDefault();
      void writeTextToClipboard(String(pr.number)).then(
        () => toastManager.add({ type: "success", title: "PR number copied" }),
        () => toastManager.add({ type: "error", title: "Could not copy PR number" }),
      );
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [keybindings, pr.number]);

  const tab = activeTab ?? localTab;
  const setTab = (next: PrDetailTab) => {
    setLocalTab(next);
    onTabChange?.(next);
  };
  const mutations = usePrDetailMutations(pr);
  const tabs: ReadonlyArray<{ readonly id: PrDetailTab; readonly label: string }> = [
    { id: "summary", label: "Summary" },
    { id: "timeline", label: "Timeline" },
    { id: "review_threads", label: "Review threads" },
    { id: "files", label: `Files (${pr.changedFiles})` },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-1 border-b border-border" role="tablist">
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            aria-selected={tab === candidate.id}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === candidate.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      {tab === "summary" ? (
        <PrSummaryTab pr={pr} active summary={summary} mutations={mutations} />
      ) : tab === "timeline" ? (
        <PrTimelineTab pr={pr} active mutations={mutations} />
      ) : tab === "review_threads" ? (
        <PrReviewThreadsTab key={pr.key} pr={pr} />
      ) : (
        <PrFilesTab pr={pr} active />
      )}
    </div>
  );
}
