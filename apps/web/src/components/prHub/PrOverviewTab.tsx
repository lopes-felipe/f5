import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, ChevronRightIcon, LoaderCircleIcon, SparklesIcon } from "lucide-react";
import type { PrHubAdvisory, ThreadId, TrackedPullRequest } from "@t3tools/contracts";
import { prAttentionText } from "@t3tools/shared/prHub";

import { getPrHubAccountGeneration } from "../../lib/prHubAccount";
import { prHubDetailQueryOptions } from "../../lib/prHubReactQuery";
import { formatAbsoluteTimeLabel, formatRelativeTimeLabel } from "../../lib/relativeTime";
import { ensureNativeApi } from "../../nativeApi";
import { OpenLinkAnchor } from "../OpenLinkAnchor";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ForgeControls } from "./ForgeControls";
import { ForgeReactionControl } from "./ForgeReactionControl";
import { PrAdvisoryInline } from "./PrAdvisoryInline";
import { PrAuthorLink } from "./PrAuthorLink";
import { PrDescription } from "./PrDescription";
import { prDetailCapability } from "./prDetails.logic";
import { mergeableLabel, waitingLabel } from "./prHubPresentation";
import type { PrChecklistActionKind } from "./prQueueModel";
import type { PrQueueTab } from "./prQueueSearch";
import { PrThreadChip } from "./PrQueueTable";
import { PrReactionBar } from "./PrReactionBar";
import { PrReviewersSection } from "./PrReviewerPicker";
import { PrStackSection } from "./PrStackSection";
import { PrStatusChecklist } from "./PrStatusChecklist";
import type { usePrDetailMutations } from "./usePrDetailMutations";

/** What the Overview tab shows besides the pull request's own detail. */
export interface PrOverviewExtras {
  advisory?: PrHubAdvisory | undefined;
  isAnalyzingAdvisory?: boolean | undefined;
  onAnalyzeAdvisory?: (() => void) | undefined;
  /** Set where a linked thread can be opened; without it the threads are not listed. */
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  /** The branch steps of the status checklist; the other steps stay inside the tabs. */
  onBranchAction?: ((kind: "update_branch" | "resolve_conflicts") => void) | undefined;
  /** Opens the reviewer editor at once, for "Request reviewers" pressed elsewhere. */
  defaultEditingReviewers?: boolean | undefined;
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-sm text-sm font-semibold focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90"
        />
        {title}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-3">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}

function SideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** How the hub last read this pull request: for diagnosing a wrong status, not for daily use. */
function SyncDetails({ pr }: { pr: TrackedPullRequest }) {
  const waiting = waitingLabel(pr);
  return (
    <dl className="flex flex-col gap-3">
      <Fact label="Verified">
        {pr.lastVerifiedAt ? (
          <span title={formatAbsoluteTimeLabel(pr.lastVerifiedAt)}>
            {formatRelativeTimeLabel(pr.lastVerifiedAt)}
          </span>
        ) : (
          "Not verified yet"
        )}
      </Fact>
      {pr.reviewFactsComplete !== true ? (
        <Fact label="Review coverage">
          {pr.reviewFactsComplete === false
            ? "Partial: more review history remains to scan"
            : "Not verified yet"}
        </Fact>
      ) : null}
      <Fact label="Mergeable">
        {mergeableLabel(pr.mergeable)}
        {pr.mergeStateStatus && pr.mergeStateStatus !== "CLEAN" ? (
          <span className="text-muted-foreground"> · {pr.mergeStateStatus.toLowerCase()}</span>
        ) : null}
      </Fact>
      {waiting && pr.waitingSince ? (
        <Fact label="Waiting">
          <span title={formatAbsoluteTimeLabel(pr.waitingSince)}>{waiting}</span>
        </Fact>
      ) : null}
      {pr.reasons && pr.reasons.length > 0 ? (
        <Fact label="Reasons">
          <ul className="flex flex-col gap-1">
            {pr.reasons.map((reason) => (
              <li key={reason.code} title={formatAbsoluteTimeLabel(reason.firstObservedAt)}>
                {prAttentionText(reason.code, pr.actionableUnresolvedThreadCount).nextAction}
                <span className="text-muted-foreground">
                  {" "}
                  · {reason.actor === "viewer" ? "you" : reason.actor}
                  {reason.verification === "unverified" ? " · unverified" : ""}
                </span>
                {reason.evidence.length > 0 ? (
                  <span className="flex flex-wrap gap-2 text-xs">
                    {reason.evidence.slice(0, 5).map((evidence, index) => (
                      <OpenLinkAnchor
                        key={evidence.id}
                        href={evidence.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        Evidence {index + 1}
                      </OpenLinkAnchor>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {pr.reasonEvidenceTruncated ? (
            <p className="text-xs text-muted-foreground">
              Some references are omitted; counts include every scanned thread.
            </p>
          ) : null}
        </Fact>
      ) : null}
      <Fact label="Merge requirements">
        {pr.mergeRequirements?.explanation ?? "Effective branch rules have not been verified."}
        {pr.mergeRequirements?.checks.map((check) => (
          <span
            className="block text-xs text-muted-foreground"
            key={`${check.name}:${check.appId}`}
          >
            {check.name}: {check.state}
          </span>
        ))}
      </Fact>
      <Fact label="Opened">
        <span title={formatAbsoluteTimeLabel(pr.createdAt)}>
          {formatRelativeTimeLabel(pr.createdAt)}
        </span>
      </Fact>
    </dl>
  );
}

function LinkedThreads({
  pr,
  onOpenThread,
}: {
  pr: TrackedPullRequest;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const generation = getPrHubAccountGeneration();
  const query = useQuery({
    queryKey: ["prHub", "threadsForPr", generation, pr.key] as const,
    queryFn: () => ensureNativeApi().prHub.getThreadsForPr({ key: pr.key }),
    staleTime: 30_000,
    retry: false,
  });
  if (!query.data || query.data.length === 0) return null;
  return (
    <SideSection title="Linked threads">
      <div className="flex flex-wrap gap-1.5">
        {query.data.map((link) => (
          <PrThreadChip key={link.threadId} link={link} onOpen={onOpenThread} />
        ))}
      </div>
    </SideSection>
  );
}

export function PrOverviewTab({
  pr,
  mutations,
  onShowTab,
  advisory,
  isAnalyzingAdvisory = false,
  onAnalyzeAdvisory,
  onOpenThread,
  onBranchAction,
  defaultEditingReviewers = false,
}: PrOverviewExtras & {
  pr: TrackedPullRequest;
  mutations: ReturnType<typeof usePrDetailMutations>;
  onShowTab: (tab: PrQueueTab) => void;
}) {
  const detailQuery = useQuery(prHubDetailQueryOptions(pr.key));
  const [editingReviewers, setEditingReviewers] = useState(defaultEditingReviewers);
  const detail = detailQuery.data?.detail;
  const githubDetails =
    detail?.providerDetails.provider === "github" ? detail.providerDetails : null;
  const reactionCapability = prDetailCapability(pr, "react");
  const actionable = pr.state === "open" && pr.ignoredAt === null;
  const onChecklistAction = (kind: PrChecklistActionKind) => {
    if (kind === "view_checks") onShowTab("checks");
    else if (kind === "view_threads") onShowTab("threads");
    else if (kind === "request_reviewers") setEditingReviewers(true);
    else onBranchAction?.(kind);
  };

  return (
    <div className="@container/proverview" role="tabpanel" aria-label="Overview">
      <div className="grid grid-cols-1 gap-6 pb-4 @4xl/proverview:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col gap-5">
          {pr.repositoryArchived ? (
            <p className="text-sm text-muted-foreground">
              This repository is archived, so the pull request is read-only.
            </p>
          ) : null}
          {pr.state === "open" ? <PrStatusChecklist pr={pr} onAction={onChecklistAction} /> : null}

          {detailQuery.data?.warning ? (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>Showing cached pull request details</AlertTitle>
              <AlertDescription>{detailQuery.data.warning}</AlertDescription>
            </Alert>
          ) : null}
          {detail?.truncatedSections && detail.truncatedSections.length > 0 ? (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>Some pull request details are incomplete</AlertTitle>
              <AlertDescription>
                The forge returned only the first page of: {detail.truncatedSections.join(", ")}. Do
                not treat the visible checks or reviewers as exhaustive.
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="flex min-w-0 flex-col gap-2" aria-labelledby="pr-description-heading">
            <h3 id="pr-description-heading" className="text-sm font-semibold">
              Description
            </h3>
            {detailQuery.isPending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" /> Loading pull request details…
              </div>
            ) : detailQuery.isError ? (
              <Alert variant="error">
                <AlertTriangleIcon />
                <AlertTitle>Pull request details unavailable</AlertTitle>
                <AlertDescription>
                  <span>
                    {detailQuery.error instanceof Error
                      ? detailQuery.error.message
                      : "The pull request details could not be loaded."}
                  </span>
                  <Button size="xs" variant="outline" onClick={() => void detailQuery.refetch()}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : detail?.body.trim() ? (
              <PrDescription
                key={pr.key}
                pr={pr}
                body={detail.body}
                readingVersion={detailQuery.dataUpdatedAt}
                canEdit={
                  !!pr.forgeCapabilities?.edit.changeRequest &&
                  !pr.repositoryArchived &&
                  (githubDetails?.viewerCanUpdate ?? pr.provider !== "github")
                }
              />
            ) : (
              <p className="text-sm text-muted-foreground">No description provided.</p>
            )}
            {detail && pr.provider === "github" ? (
              <PrReactionBar
                prKey={pr.key}
                subjectId={githubDetails?.nodeId ?? null}
                reactions={detail.reactions}
                disabledReason={reactionCapability.supported ? null : reactionCapability.reason}
                isPending={mutations.setReaction.isPending}
                onSetReaction={(input) => mutations.setReaction.mutate(input)}
              />
            ) : detail && pr.forgeCapabilities?.reactions ? (
              <ForgeReactionControl pr={pr} />
            ) : null}
          </section>

          <PrStackSection pr={pr} />

          {advisory ? (
            <section className="flex min-w-0 flex-col gap-2" aria-label="AI recommendation">
              <h3 className="text-sm font-semibold">AI recommendation</h3>
              <PrAdvisoryInline advisory={advisory} defaultExpanded />
            </section>
          ) : actionable && onAnalyzeAdvisory ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              disabled={isAnalyzingAdvisory}
              onClick={onAnalyzeAdvisory}
            >
              <SparklesIcon className={isAnalyzingAdvisory ? "animate-pulse" : ""} />
              {isAnalyzingAdvisory ? "Analyzing…" : "Get an AI recommendation"}
            </Button>
          ) : null}

          {pr.forgeCapabilities && !pr.repositoryArchived ? (
            <Disclosure title="Comment, labels and other forge actions">
              <ForgeControls pr={pr} detail={detail} />
            </Disclosure>
          ) : null}
        </div>

        <aside aria-label="People and details" className="flex min-w-0 flex-col gap-5">
          <SideSection title="Author">
            <span className="text-sm">
              <PrAuthorLink prUrl={pr.url} login={pr.author} />
            </span>
          </SideSection>
          <PrReviewersSection
            pr={pr}
            detail={detail}
            mutations={mutations}
            editing={editingReviewers}
            onEditingChange={setEditingReviewers}
          />
          {pr.assignees.length > 0 ? (
            <SideSection title="Assignees">
              <div className="flex flex-wrap gap-1.5">
                {pr.assignees.map((assignee) => (
                  <Badge key={assignee} variant="outline" size="sm">
                    {assignee}
                  </Badge>
                ))}
              </div>
            </SideSection>
          ) : null}
          {pr.labels.length > 0 ? (
            <SideSection title="Labels">
              <div className="flex flex-wrap gap-1.5">
                {pr.labels.map((label) => (
                  <Badge key={label} variant="outline" size="sm">
                    {label}
                  </Badge>
                ))}
              </div>
            </SideSection>
          ) : null}
          {onOpenThread ? <LinkedThreads pr={pr} onOpenThread={onOpenThread} /> : null}
          <Disclosure title="Sync details">
            <SyncDetails pr={pr} />
          </Disclosure>
        </aside>
      </div>
    </div>
  );
}
