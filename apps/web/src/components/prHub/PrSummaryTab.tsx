import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckCircle2Icon, LoaderCircleIcon } from "lucide-react";
import type { PrHubReviewer, TrackedPullRequest } from "@t3tools/contracts";

import { prHubDetailQueryOptions } from "../../lib/prHubReactQuery";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PrReactionBar } from "./PrReactionBar";
import { prDetailCapability } from "./prDetails.logic";
import type { usePrDetailMutations } from "./usePrDetailMutations";

function reviewerLabel(reviewer: PrHubReviewer): string {
  return reviewer.kind === "team" ? `@${reviewer.login}` : reviewer.login;
}

function splitReviewers(value: string): string[] {
  return value
    .split(",")
    .map((reviewer) => reviewer.trim())
    .filter(Boolean);
}

export function PrSummaryTab({
  pr,
  active,
  summary,
  mutations,
}: {
  pr: TrackedPullRequest;
  active: boolean;
  summary: ReactNode;
  mutations: ReturnType<typeof usePrDetailMutations>;
}) {
  const detailQuery = useQuery({ ...prHubDetailQueryOptions(pr.key), enabled: active });
  const [addReviewers, setAddReviewers] = useState("");
  const [removeReviewers, setRemoveReviewers] = useState("");
  const reactionCapability = prDetailCapability(pr, "react");
  const reviewerCapability = prDetailCapability(pr, "change-reviewers");
  const branchCapability = prDetailCapability(pr, "update-branch");
  const detail = detailQuery.data?.detail;
  const githubDetails =
    detail?.providerDetails.provider === "github" ? detail.providerDetails : null;
  const reviewerChangesPresent =
    addReviewers.trim().length > 0 || removeReviewers.trim().length > 0;
  const branchDisabledReason = !branchCapability.supported
    ? branchCapability.reason
    : githubDetails && !githubDetails.viewerCanUpdate
      ? "GitHub does not allow the current account to update this branch."
      : detail?.state !== "open"
        ? "Only open pull requests can update their branch."
        : null;

  return (
    <div className="flex flex-col gap-5" role="tabpanel" aria-label="Summary">
      {summary}

      {detailQuery.isPending ? (
        <div className="flex items-center gap-2 border-t border-border pt-4 text-sm text-muted-foreground">
          <LoaderCircleIcon className="size-4 animate-spin" /> Loading GitHub details…
        </div>
      ) : detailQuery.isError ? (
        <Alert variant="error">
          <AlertTriangleIcon />
          <AlertTitle>GitHub details unavailable</AlertTitle>
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
      ) : detail ? (
        <div className="flex flex-col gap-5 border-t border-border pt-4">
          {detailQuery.data.warning ? (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>Showing cached GitHub details</AlertTitle>
              <AlertDescription>{detailQuery.data.warning}</AlertDescription>
            </Alert>
          ) : null}

          <section className="space-y-2" aria-labelledby="pr-description-heading">
            <h3 id="pr-description-heading" className="text-sm font-semibold">
              Description
            </h3>
            {detail.body.trim() ? (
              <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/20 p-3 text-sm leading-relaxed">
                {detail.body}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No description provided.</p>
            )}
          </section>

          <section className="space-y-2" aria-labelledby="pr-checks-heading">
            <h3 id="pr-checks-heading" className="text-sm font-semibold">
              Checks
            </h3>
            {detail.checks.length > 0 ? (
              <div className="grid gap-1.5">
                {detail.checks.map((check, index) => (
                  <div
                    key={`${check.name}-${index}`}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/70 px-2.5 py-2 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <CheckCircle2Icon
                        className={
                          check.status === "success"
                            ? "size-4 shrink-0 text-success"
                            : check.status === "failure"
                              ? "size-4 shrink-0 text-destructive"
                              : "size-4 shrink-0 text-muted-foreground"
                        }
                      />
                      <span className="truncate">{check.name}</span>
                    </span>
                    <Badge variant="outline" size="sm">
                      {check.status}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No check runs reported.</p>
            )}
          </section>

          <section className="space-y-2" aria-labelledby="pr-reactions-heading">
            <h3 id="pr-reactions-heading" className="text-sm font-semibold">
              Reactions
            </h3>
            <PrReactionBar
              prKey={pr.key}
              subjectId={githubDetails?.nodeId ?? null}
              reactions={detail.reactions}
              disabledReason={reactionCapability.supported ? null : reactionCapability.reason}
              isPending={mutations.setReaction.isPending}
              onSetReaction={(input) => mutations.setReaction.mutate(input)}
            />
          </section>

          <section className="space-y-3" aria-labelledby="pr-reviewers-heading">
            <div>
              <h3 id="pr-reviewers-heading" className="text-sm font-semibold">
                Reviewers
              </h3>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {detail.reviewers.length > 0 ? (
                  detail.reviewers.map((reviewer) => (
                    <Badge key={`${reviewer.kind}:${reviewer.login}`} variant="outline" size="sm">
                      {reviewerLabel(reviewer)} {reviewer.requested ? "· requested" : "· reviewed"}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">No reviewers.</span>
                )}
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 text-xs text-muted-foreground">
                Add reviewers
                <Input
                  size="sm"
                  value={addReviewers}
                  placeholder="alice, org/team"
                  disabled={!reviewerCapability.supported || mutations.changeReviewers.isPending}
                  onChange={(event) => setAddReviewers(event.target.value)}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Remove reviewers
                <Input
                  size="sm"
                  value={removeReviewers}
                  placeholder="bob"
                  disabled={!reviewerCapability.supported || mutations.changeReviewers.isPending}
                  onChange={(event) => setRemoveReviewers(event.target.value)}
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                title={reviewerCapability.reason ?? undefined}
                disabled={
                  !reviewerCapability.supported ||
                  !reviewerChangesPresent ||
                  mutations.changeReviewers.isPending
                }
                onClick={() => {
                  void mutations.changeReviewers
                    .mutateAsync({
                      key: pr.key,
                      add: splitReviewers(addReviewers),
                      remove: splitReviewers(removeReviewers),
                    })
                    .then(() => {
                      setAddReviewers("");
                      setRemoveReviewers("");
                    })
                    .catch(() => undefined);
                }}
              >
                {mutations.changeReviewers.isPending ? "Updating…" : "Apply reviewer changes"}
              </Button>
              {!reviewerCapability.supported ? (
                <span className="text-xs text-muted-foreground">{reviewerCapability.reason}</span>
              ) : null}
            </div>
          </section>

          <section className="space-y-2" aria-labelledby="pr-branch-heading">
            <h3 id="pr-branch-heading" className="text-sm font-semibold">
              Branch update
            </h3>
            <p className="text-sm text-muted-foreground">
              Bring {detail.headRefName ?? "the pull request branch"} up to date with{" "}
              {detail.baseRefName ?? "its base branch"}.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {(["merge", "rebase"] as const).map((method) => (
                <Button
                  key={method}
                  size="sm"
                  variant="outline"
                  title={branchDisabledReason ?? undefined}
                  disabled={Boolean(branchDisabledReason) || mutations.updateBranch.isPending}
                  onClick={() => mutations.updateBranch.mutate({ key: pr.key, method })}
                >
                  {mutations.updateBranch.isPending
                    ? "Updating…"
                    : `${method === "merge" ? "Merge" : "Rebase"} base branch`}
                </Button>
              ))}
              {branchDisabledReason ? (
                <span className="text-xs text-muted-foreground">{branchDisabledReason}</span>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
