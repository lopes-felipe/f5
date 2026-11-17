import { resolveShortcutCommand, useServerKeybindings } from "~/keybindings";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { toastManager } from "~/components/ui/toast";
import { UnderlineTabs, type UnderlineTab } from "~/components/ui/underline-tabs";
import { lazy, Suspense, useEffect, useState } from "react";
import type { TrackedPullRequest } from "@t3tools/contracts";

import { PrChecksTab, type PrChecksTabProps } from "./PrChecksTab";
import { PrFilesTab } from "./PrFilesTab";
import { PrOverviewTab, type PrOverviewExtras } from "./PrOverviewTab";
import type { PrQueueTab } from "./prQueueSearch";
import { PrReviewThreadsTab } from "./PrReviewThreadsTab";
import { PrTimelineTab } from "./PrTimelineTab";
import { usePrDetailMutations } from "./usePrDetailMutations";

const PrReviewGuideTab = lazy(() =>
  import("./PrReviewGuideTab").then((module) => ({ default: module.PrReviewGuideTab })),
);

/** The tabs of a pull request; the same names the queue keeps in the URL. */
export type PrDetailTab = PrQueueTab;

export function PrDetailsTabs({
  pr,
  activeTab,
  onTabChange,
  overview,
  checks,
}: {
  pr: TrackedPullRequest;
  activeTab?: PrDetailTab | undefined;
  onTabChange?: ((tab: PrDetailTab) => void) | undefined;
  overview?: PrOverviewExtras | undefined;
  /** The steps the Checks tab offers; without them it only lists the checks. */
  checks?: Omit<PrChecksTabProps, "pr"> | undefined;
}) {
  const [localTab, setLocalTab] = useState<PrDetailTab>("overview");
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
  const tabs: ReadonlyArray<UnderlineTab<PrDetailTab>> = [
    { value: "overview", label: "Overview" },
    { value: "conversation", label: "Conversation" },
    {
      value: "threads",
      label: pr.unresolvedThreadCount > 0 ? `Threads (${pr.unresolvedThreadCount})` : "Threads",
    },
    { value: "files", label: `Files (${pr.changedFiles})` },
    { value: "checks", label: "Checks" },
    { value: "guide", label: "Guide · Beta" },
  ];

  return (
    <div data-pr-detail-tabs className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
      <UnderlineTabs
        className="shrink-0"
        aria-label="Pull request sections"
        tabs={tabs}
        value={tab}
        onValueChange={setTab}
        scrollable
      />

      {tab === "conversation" ? (
        <PrTimelineTab key={pr.key} pr={pr} active mutations={mutations} />
      ) : (
        <div
          data-pr-content-scroller
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
        >
          {tab === "overview" ? (
            <PrOverviewTab
              key={pr.key}
              pr={pr}
              mutations={mutations}
              onShowTab={setTab}
              {...overview}
            />
          ) : tab === "threads" ? (
            <PrReviewThreadsTab key={pr.key} pr={pr} />
          ) : tab === "checks" ? (
            <PrChecksTab key={pr.key} pr={pr} {...checks} />
          ) : tab === "guide" ? (
            <Suspense fallback={<p>Loading review guide…</p>}>
              <PrReviewGuideTab key={pr.key} pr={pr} />
            </Suspense>
          ) : (
            <PrFilesTab pr={pr} active />
          )}
        </div>
      )}
    </div>
  );
}
