import {
  CodeReviewWorkflowId,
  CommandId,
  ProjectId,
  TurnId,
  deriveCodeReviewWorkflowStatus,
  type ClientThreadTurnStartCommand,
  type CodeReviewWorkflow,
  type OrchestrationCreateCodeReviewWorkflowInput,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type UpstreamPortReviewSummary,
} from "@t3tools/contracts";
import { formatUpstreamTopicTrailer } from "@t3tools/shared/upstreamPorts";
import { parseUpstreamOutcome } from "@t3tools/shared/upstreamPortsPrompts";
import { Effect, Fiber, Stream } from "effect";
import { makeOperationGate } from "../provider/operationGate.ts";
import {
  resolveTurnSubmissionStatus,
  type TurnSubmissionStatus,
} from "../nextTurnQueue/submissionStatus.ts";
import {
  getFinishedConsumableLatestTurn,
  reviewFeedbackForPinnedTurn,
  workflowPromptFitError,
} from "../orchestration/workflowSharedUtils.ts";
import { buildPortRevisionCommand } from "./admission.ts";
import { LATEST_WORKFLOW_TEMPLATE_VERSION } from "../orchestration/workflowBehavior.ts";
import { parseGitHubRepo, type LedgerPullRequest, type UpstreamGitHub } from "./github.ts";
import {
  buildPortReviewRequest,
  buildPortRevisionPrompt,
  portReviewReportArtifact,
} from "./reviewPrompts.ts";
import type { UpstreamPortsHost } from "./service.ts";
import type {
  PortGroupRecord,
  PortLinkRecord,
  PortReviewRecord,
  PortReviewSummaryRecord,
  UpstreamStore,
} from "./store.ts";

export const activePortReview = (row: PortReviewSummaryRecord) =>
  row.status === "waiting" ||
  row.status === "reviewing" ||
  row.status === "apply_pending" ||
  row.status === "applying";

export class InvalidPortReviewRetry extends Error {}

export function portReviewSummary(
  row: PortReviewSummaryRecord,
  workflow?: CodeReviewWorkflow | null,
): UpstreamPortReviewSummary {
  const workflowError =
    row.status === "reviewing" && workflow && deriveCodeReviewWorkflowStatus(workflow) === "error";
  return {
    status: workflowError ? "error" : row.status === "apply_pending" ? "applying" : row.status,
    workflowId: row.reviewWorkflowId ? CodeReviewWorkflowId.makeUnsafe(row.reviewWorkflowId) : null,
    detail: workflowError ? "Review failed; open it to retry" : row.detail,
    retryable: row.status === "error" || row.status === "skipped",
  };
}

export const parsePortPullRequestUrl = (url: string) => {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/u.exec(url);
  return match ? { repo: { owner: match[1]!, name: match[2]! }, number: Number(match[3]) } : null;
};

export type PortReviewPrLookup =
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly detail: string; readonly transient: boolean }
  | {
      readonly kind: "found";
      readonly pr: LedgerPullRequest | null;
      readonly origin: string | null;
    };

export interface PortReviewContext {
  readonly thread: OrchestrationThread | null;
  readonly group: PortGroupRecord;
  readonly links: ReadonlyArray<PortLinkRecord>;
  readonly groupSubmissionDisposition: string | null;
  readonly projectedPrUrl: string | null;
  readonly prLookup: PortReviewPrLookup;
  readonly workflow: CodeReviewWorkflow | null;
  readonly reviewerThreadsMissing: boolean;
  readonly report: string | null;
  readonly submission: TurnSubmissionStatus | null;
}

type ErrorStage = NonNullable<PortReviewRecord["errorStage"]>;
export type PortReviewStep =
  | { readonly kind: "wait"; readonly detail?: string | null }
  | {
      readonly kind: "skip";
      readonly detail: string;
      readonly cancelRevision: boolean;
      readonly archiveWorkflow: boolean;
    }
  | { readonly kind: "startReview"; readonly prUrl: string; readonly headSha: string | null }
  | { readonly kind: "createWorkflow" }
  | { readonly kind: "prepareApply" }
  | { readonly kind: "submit" }
  | { readonly kind: "complete" }
  | { readonly kind: "fail"; readonly stage: ErrorStage; readonly detail: string };

export function nextPortReviewStep(row: PortReviewRecord, ctx: PortReviewContext): PortReviewStep {
  const wait = (detail?: string | null): PortReviewStep => ({
    kind: "wait",
    ...(detail === undefined ? {} : { detail }),
  });
  const skip = (detail: string): PortReviewStep => ({
    kind: "skip",
    detail,
    cancelRevision: row.status === "apply_pending" || row.status === "applying",
    archiveWorkflow: row.status === "reviewing",
  });
  const fail = (stage: ErrorStage, detail: string): PortReviewStep => ({
    kind: "fail",
    stage,
    detail,
  });
  if (!activePortReview(row)) return wait();
  if (!ctx.thread) {
    if (
      ctx.group.status === "rejected" ||
      (ctx.group.status === "submitted" &&
        ["canceled", "cleared", "rejected"].includes(ctx.groupSubmissionDisposition ?? ""))
    )
      return skip("Port submission rejected or canceled");
    return wait();
  }
  if (ctx.thread.deletedAt) return skip("Port thread deleted");
  if (!ctx.links.some((link) => link.state === "active")) return skip("Port unlinked");
  if (ctx.thread.archivedAt) return skip("Port thread archived");
  if (row.status === "waiting") {
    const finished = getFinishedConsumableLatestTurn(ctx.thread);
    const outcome = finished ? parseUpstreamOutcome(finished.assistantText) : null;
    if (!row.prUrl && !ctx.projectedPrUrl) {
      if (!outcome) {
        const state = ctx.thread.latestTurn?.state;
        return state === "error" || state === "interrupted"
          ? fail(
              "review-setup",
              "Port turn " + state + "; finish the port or Retry review after opening a PR",
            )
          : wait();
      }
      if (outcome.kind !== "pr") return skip("Port ended with " + outcome.kind);
    }
    const prUrl = row.prUrl ?? ctx.projectedPrUrl ?? outcome?.detail ?? "";
    if (!parsePortPullRequestUrl(prUrl)) return skip("Port outcome has no valid pull request URL");
    const lookup = ctx.prLookup;
    if (lookup.kind === "unavailable")
      return wait("GitHub unavailable; connect GitHub to verify the port PR");
    if (lookup.kind === "error")
      return lookup.transient ? wait(lookup.detail) : fail("review-setup", lookup.detail);
    if (lookup.kind === "found") {
      if (!lookup.pr) return fail("review-setup", "Pull request was not found");
      if (lookup.pr.state !== "open") return skip("Pull request is " + lookup.pr.state);
      if (
        !lookup.origin ||
        lookup.pr.headRepoFullName?.toLowerCase() !== lookup.origin.toLowerCase()
      )
        return fail(
          "review-setup",
          "Pull request head repository " +
            (lookup.pr.headRepoFullName ?? "(unknown)") +
            " does not match origin " +
            (lookup.origin ?? "(unknown)"),
        );
      if (!ctx.thread.branch || lookup.pr.headRef !== ctx.thread.branch)
        return fail(
          "review-setup",
          "Pull request head branch " +
            (lookup.pr.headRef ?? "(unknown)") +
            " does not match port branch " +
            (ctx.thread.branch ?? "(unknown)"),
        );
      if (!lookup.pr.headSha)
        return fail("review-setup", "Pull request head is unknown; Retry review to pin it");
    }
    return {
      kind: "startReview",
      prUrl,
      headSha: lookup.kind === "found" ? (lookup.pr?.headSha ?? null) : null,
    };
  }
  if (row.status === "reviewing") {
    const workflow = ctx.workflow;
    if (!workflow) return { kind: "createWorkflow" };
    if (workflow.deletedAt) return fail("review", "Review workflow deleted");
    if (
      workflow.archivedAt &&
      !(
        row.errorStage === "apply-feedback" &&
        deriveCodeReviewWorkflowStatus(workflow) === "completed"
      )
    )
      return skip("Review workflow archived");
    if (ctx.reviewerThreadsMissing) return { kind: "createWorkflow" };
    const status = deriveCodeReviewWorkflowStatus(workflow);
    if (status !== "completed") return wait();
    if (!ctx.report?.trim()) return fail("review", "Review completed with an empty report");
    if (ctx.prLookup.kind === "unavailable")
      return wait("GitHub unavailable; waiting to verify the reviewed PR head");
    if (ctx.prLookup.kind === "error")
      return ctx.prLookup.transient
        ? wait(ctx.prLookup.detail)
        : fail("review", ctx.prLookup.detail);
    if (ctx.prLookup.kind === "found") {
      if (!ctx.prLookup.pr) return fail("review", "Pull request was not found");
      if (ctx.prLookup.pr.state !== "open") return skip("Pull request is " + ctx.prLookup.pr.state);
      if (!row.reviewedHeadSha || !ctx.prLookup.pr.headSha)
        return fail("review", "Pull request head is unknown; Retry review re-reviews it");
      if (
        row.reviewedHeadSha &&
        ctx.prLookup.pr.headSha &&
        row.reviewedHeadSha !== ctx.prLookup.pr.headSha
      )
        return fail(
          "review",
          "Pull request changed after review (" +
            row.reviewedHeadSha +
            "→" +
            ctx.prLookup.pr.headSha +
            "); Retry review re-reviews it",
        );
    }
    return { kind: "prepareApply" };
  }
  if (row.status === "apply_pending")
    return row.submitFailures >= 3
      ? fail("apply-feedback", row.detail ?? "Revision submission failed")
      : { kind: "submit" };
  const status = ctx.submission;
  if (!status) return wait();
  switch (status.status) {
    case "blocked":
      return wait("Revision blocked: " + (status.reason ?? "Blocked"));
    case "rejected":
      return fail("apply-feedback", "Revision was removed from the queue");
    case "interrupted":
    case "failed":
      return fail(
        "apply-feedback",
        "Revision " + status.status + (status.reason ? ": " + status.reason : ""),
      );
    case "completed":
      return { kind: "complete" };
    default:
      return wait(null);
  }
}

export interface PortReviewReactorDeps {
  readonly host: UpstreamPortsHost;
  readonly store: UpstreamStore;
  readonly github: UpstreamGitHub | null;
  readonly context: (
    projectId: string,
  ) => Effect.Effect<{ readonly cwd: string; readonly ledgerDir: string }, Error>;
  readonly originUrl: (cwd: string) => Effect.Effect<string | null, Error>;
  readonly projectedPrUrl: (threadId: string) => Effect.Effect<string | null, Error>;
  readonly emit: (projectId: string) => Effect.Effect<void>;
  readonly now: () => Date;
  readonly mintId: () => string;
}

type LoadedPortReviewContext = PortReviewContext & {
  readonly project: { readonly cwd: string; readonly ledgerDir: string };
  readonly model: OrchestrationReadModel;
};

/** Level triggered: persisted intent always precedes creation or queue submission. */
export function makePortReviewReactor(deps: PortReviewReactorDeps) {
  const { host, store } = deps;
  const withLock = makeOperationGate<string>();
  const activeThreads = new Map<string, string>();
  const activeWorkflows = new Map<string, string>();
  const workflowByThread = new Map<string, string>();
  const applyingThreads = new Set<string>();
  const pendingRetryThreads = new Set<string>();
  const summaryKeys = new Map<string, string>();
  const indexVersions = new Map<string, number>();
  let indexVersion = 0;
  const removeIndex = (threadId: string) => {
    activeThreads.delete(threadId);
    applyingThreads.delete(threadId);
    pendingRetryThreads.delete(threadId);
    const workflow = workflowByThread.get(threadId);
    if (workflow) activeWorkflows.delete(workflow);
    workflowByThread.delete(threadId);
    indexVersions.delete(threadId);
    summaryKeys.delete(threadId);
  };
  const index = (row: PortReviewRecord) => {
    activeThreads.delete(row.threadId);
    applyingThreads.delete(row.threadId);
    pendingRetryThreads.delete(row.threadId);
    const previousWorkflow = workflowByThread.get(row.threadId);
    if (previousWorkflow) activeWorkflows.delete(previousWorkflow);
    workflowByThread.delete(row.threadId);
    if (activePortReview(row)) {
      indexVersions.set(row.threadId, ++indexVersion);
      activeThreads.set(row.threadId, row.threadId);
      if (row.reviewWorkflowId) {
        activeWorkflows.set(row.reviewWorkflowId, row.threadId);
        workflowByThread.set(row.threadId, row.reviewWorkflowId);
      }
      if (row.status === "apply_pending" || row.status === "applying")
        applyingThreads.add(row.threadId);
      if (row.status === "apply_pending" && row.submitFailures > 0)
        pendingRetryThreads.add(row.threadId);
    } else removeIndex(row.threadId);
  };
  const notify = (row: PortReviewRecord, workflow?: CodeReviewWorkflow | null) =>
    Effect.gen(function* () {
      const key = JSON.stringify(portReviewSummary(row, workflow));
      if (summaryKeys.get(row.threadId) !== key) {
        if (activePortReview(row)) summaryKeys.set(row.threadId, key);
        yield* deps.emit(row.projectId);
      }
    });
  const save = (row: PortReviewRecord, patch: Partial<PortReviewRecord>) =>
    Effect.gen(function* () {
      const next = { ...row, ...patch, updatedAt: deps.now().toISOString() };
      yield* store.updatePortReview(next);
      index(next);
      if (activePortReview(next))
        summaryKeys.set(next.threadId, JSON.stringify(portReviewSummary(next)));
      yield* deps.emit(next.projectId);
      return next;
    });
  const lookup = (cwd: string, prUrl: string | null): Effect.Effect<PortReviewPrLookup> =>
    Effect.gen(function* () {
      if (!prUrl) return { kind: "unavailable" } as const;
      const parsed = parsePortPullRequestUrl(prUrl);
      if (!parsed)
        return { kind: "error", transient: false, detail: "Invalid pull request URL" } as const;
      const originUrl = yield* deps.originUrl(cwd);
      const origin = originUrl ? parseGitHubRepo(originUrl) : null;
      if (
        !origin ||
        (parsed.repo.owner + "/" + parsed.repo.name).toLowerCase() !==
          (origin.owner + "/" + origin.name).toLowerCase()
      )
        return {
          kind: "error",
          transient: false,
          detail: "Pull request URL does not belong to origin",
        } as const;
      if (!deps.github || !(yield* deps.github.available(cwd)))
        return { kind: "unavailable" } as const;
      const pr = yield* deps.github.findPullRequest({ cwd, ...parsed });
      return {
        kind: "found",
        pr,
        origin: origin ? origin.owner + "/" + origin.name : null,
      } as const;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          kind: "error" as const,
          detail: error.message,
          transient: "transient" in error ? Boolean(error.transient) : true,
        }),
      ),
    );

  const readContext = (
    row: PortReviewRecord,
  ): Effect.Effect<
    PortReviewContext & {
      readonly project: { readonly cwd: string; readonly ledgerDir: string };
      readonly model: OrchestrationReadModel;
    },
    Error
  > =>
    Effect.gen(function* () {
      const project = yield* deps.context(row.projectId);
      const model = yield* host.readModel;
      const thread = model.threads.find((entry) => entry.id === row.threadId) ?? null;
      const group = (yield* store.listGroups(row.projectId, row.clientRequestId)).find(
        (entry) => entry.groupIndex === row.groupIndex,
      );
      if (!group) return yield* Effect.fail(new Error("Port group missing"));
      const links = (yield* store.listLinks(row.projectId)).filter(
        (entry) => entry.threadId === row.threadId,
      );
      const workflow =
        model.codeReviewWorkflows.find((entry) => entry.id === row.reviewWorkflowId) ?? null;
      const consolidationThread = model.threads.find(
        (entry) => entry.id === workflow?.consolidation.threadId,
      );
      const report =
        workflow && consolidationThread
          ? (reviewFeedbackForPinnedTurn(
              consolidationThread,
              workflow.consolidation.pinnedTurnId,
              workflow.consolidation.pinnedAssistantMessageId,
            )?.text ?? null)
          : null;
      const projectedPrUrl =
        row.status === "waiting" ? yield* deps.projectedPrUrl(row.threadId) : null;
      const finished = getFinishedConsumableLatestTurn(thread);
      const outcome = finished ? parseUpstreamOutcome(finished.assistantText) : null;
      const prUrl = row.prUrl ?? projectedPrUrl ?? (outcome?.kind === "pr" ? outcome.detail : null);
      const eligible =
        thread &&
        !thread.deletedAt &&
        !thread.archivedAt &&
        links.some((link) => link.state === "active");
      const needsPr =
        eligible &&
        ((row.status === "waiting" && (row.prUrl || projectedPrUrl || outcome?.kind === "pr")) ||
          (row.status === "reviewing" &&
            workflow &&
            !workflow.deletedAt &&
            deriveCodeReviewWorkflowStatus(workflow) === "completed"));
      const prLookup = needsPr
        ? yield* lookup(project.cwd, prUrl)
        : { kind: "unavailable" as const };
      const groupSubmissionDisposition =
        !thread && group.status === "submitted"
          ? ((yield* host.getSubmission(CommandId.makeUnsafe(group.submissionId)))?.disposition ??
            null)
          : null;
      const submission =
        eligible && row.status === "applying" && row.applyCommandJson && thread
          ? yield* resolveTurnSubmissionStatus(host, {
              thread,
              submissionId: (JSON.parse(row.applyCommandJson) as ClientThreadTurnStartCommand)
                .commandId,
              knownTurnId: row.applyTurnId ? TurnId.makeUnsafe(row.applyTurnId) : null,
            })
          : null;
      return {
        project,
        model,
        thread,
        group,
        links,
        workflow,
        report,
        projectedPrUrl,
        prLookup,
        groupSubmissionDisposition,
        submission,
        reviewerThreadsMissing: Boolean(
          workflow &&
          [workflow.reviewerA, workflow.reviewerB].some(
            (reviewer) =>
              reviewer.status === "pending" &&
              !reviewer.dispatchCommandId &&
              !model.threads.some((entry) => entry.id === reviewer.threadId),
          ),
        ),
      } satisfies PortReviewContext & { project: typeof project; model: OrchestrationReadModel };
    });

  const advanceUnlocked = (threadId: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      let row = yield* store.getPortReviewByThread(threadId);
      if (!row) return;
      index(row);
      // Bound immediate transitions; external changes are picked up by events or the safety net.
      for (let count = 0; count < 8 && activePortReview(row); count++) {
        const ctx: LoadedPortReviewContext = yield* readContext(row);
        index(row);
        yield* notify(row, ctx.workflow);
        if (ctx.submission?.turnId && ctx.submission.turnId !== row.applyTurnId)
          row = yield* save(row, { applyTurnId: ctx.submission.turnId });
        const step = nextPortReviewStep(row, ctx);
        switch (step.kind) {
          case "wait":
            if (step.detail !== undefined && step.detail !== row.detail)
              yield* save(row, { detail: step.detail });
            return;
          case "fail":
            yield* save(row, { status: "error", errorStage: step.stage, detail: step.detail });
            return;
          case "skip": {
            let detail = step.detail;
            if (step.cancelRevision && row.applyCommandJson) {
              const command = JSON.parse(row.applyCommandJson) as ClientThreadTurnStartCommand;
              const canceled = yield* host.cancelQueuedSubmission(command.commandId);
              detail +=
                canceled === "started"
                  ? "; the revision had already started and was left running"
                  : canceled === "canceled"
                    ? "; queued revision canceled"
                    : "";
            }
            if (step.archiveWorkflow && row.reviewWorkflowId)
              yield* host
                .archiveCodeReviewWorkflow(CodeReviewWorkflowId.makeUnsafe(row.reviewWorkflowId))
                .pipe(Effect.ignoreCause({ log: true }));
            yield* save(row, { status: "skipped", detail });
            return;
          }
          case "startReview": {
            if (!row.reviewers) {
              yield* save(row, {
                status: "error",
                errorStage: "review-setup",
                detail: "Invalid stored reviewer settings; start a new port",
              });
              return;
            }
            const reviewers = row.reviewers;
            const command = ctx.group.command as ClientThreadTurnStartCommand;
            const input = yield* Effect.try({
              try: (): OrchestrationCreateCodeReviewWorkflowInput => ({
                projectId: ProjectId.makeUnsafe(row!.projectId),
                templateId: "builtin.code-review.dual",
                templateVersion: LATEST_WORKFLOW_TEMPLATE_VERSION,
                title: "Review: " + ctx.thread!.title,
                reviewPrompt: buildPortReviewRequest({
                  prUrl: step.prUrl,
                  headBranch: ctx.thread!.branch,
                  headSha: step.headSha,
                  portPrompt: command.message.text,
                  ledgerDir: ctx.project.ledgerDir,
                }),
                ...reviewers,
              }),
              catch: (error) => (error instanceof Error ? error.message : String(error)),
            }).pipe(
              Effect.catch((error) =>
                save(row!, {
                  status: "error",
                  errorStage: "review-setup",
                  detail: error,
                }).pipe(Effect.as(null)),
              ),
            );
            if (!input) return;
            row = yield* save(row, {
              status: "reviewing",
              attempt: row.attempt + 1,
              reviewWorkflowId: deps.mintId(),
              prUrl: step.prUrl,
              reviewedHeadSha: step.headSha,
              reviewInputJson: JSON.stringify(input),
              errorStage: null,
              detail: null,
              applyCommandJson: null,
              applyTurnId: null,
              submitFailures: 0,
              finalHeadSha: null,
            });
            continue;
          }
          case "createWorkflow": {
            if (!row.reviewWorkflowId || !row.reviewInputJson) {
              yield* save(row, {
                status: "error",
                errorStage: "review-setup",
                detail: "Missing persisted review intent",
              });
              return;
            }
            yield* host
              .createCodeReviewWorkflow(
                JSON.parse(row.reviewInputJson) as OrchestrationCreateCodeReviewWorkflowInput,
                CodeReviewWorkflowId.makeUnsafe(row.reviewWorkflowId),
              )
              .pipe(
                Effect.catch((error) =>
                  save(row!, {
                    status: "error",
                    errorStage: "review-setup",
                    detail: error.message,
                  }),
                ),
              );
            return;
          }
          case "prepareApply": {
            const thread = ctx.thread!;
            const providers = yield* host.listProviders;
            const provider = providers.find(
              (entry) => entry.instanceId === thread.modelSelection?.instanceId,
            );
            if (!provider?.enabled) {
              yield* save(row, {
                status: "error",
                errorStage: "apply-feedback",
                detail: "Provider unavailable",
              });
              return;
            }
            const workflow = ctx.workflow!;
            const command = ctx.group.command as ClientThreadTurnStartCommand;
            const report = ctx.report!;
            const prompt = buildPortRevisionPrompt({
              report,
              workflowId: workflow.id,
              pinnedTurnId: workflow.consolidation.pinnedTurnId,
              pinnedMessageId: workflow.consolidation.pinnedAssistantMessageId,
              prUrl: row.prUrl!,
              trailers: ctx.links
                .filter((link) => link.state === "active")
                .map((link) => formatUpstreamTopicTrailer({ id: link.topicId, epoch: link.epoch })),
              ledgerDir: ctx.project.ledgerDir,
              base: command.bootstrap?.prepareWorktree?.baseBranch ?? "main",
            });
            const fit = workflowPromptFitError({
              prompt,
              artifacts: [portReviewReportArtifact(report)],
              targetSlot: {
                provider: provider.driver as NonNullable<
                  PortReviewRecord["reviewers"]
                >["reviewerA"]["provider"],
                model: thread.modelSelection?.model ?? thread.model,
              },
              thread,
              artifactLabel: "Port review feedback",
              enforceArtifactBudget: true,
            });
            if (fit) {
              yield* save(row, {
                status: "error",
                errorStage: "apply-feedback",
                detail: fit.message,
              });
              return;
            }
            const applyCommand = buildPortRevisionCommand({
              thread,
              prompt,
              createdAt: deps.now().toISOString(),
              submissionId:
                "upstream-port-review:" +
                row.clientRequestId +
                ":" +
                row.groupIndex +
                ":" +
                row.attempt +
                ":apply",
            });
            row = yield* save(row, {
              status: "apply_pending",
              applyCommandJson: JSON.stringify(applyCommand),
              detail: null,
              errorStage: null,
            });
            continue;
          }
          case "submit": {
            const command = JSON.parse(row.applyCommandJson!) as ClientThreadTurnStartCommand;
            const result = yield* host
              .submitTurn(
                { submissionId: command.commandId, command, intent: "auto" },
                "automation",
              )
              .pipe(
                Effect.map((result) => ({ ok: true as const, result })),
                Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
              );
            if (!result.ok) {
              const failures = row.submitFailures + 1;
              yield* save(row, {
                submitFailures: failures,
                detail: result.error.message,
                ...(failures >= 3
                  ? { status: "error" as const, errorStage: "apply-feedback" as const }
                  : {}),
              });
              return;
            }
            if (
              result.result &&
              (result.result.disposition === "rejected" ||
                result.result.disposition === "canceled" ||
                result.result.disposition === "cleared")
            ) {
              yield* save(row, {
                status: "error",
                errorStage: "apply-feedback",
                detail:
                  result.result.detail ?? result.result.reasonCode ?? result.result.disposition,
              });
              return;
            }
            if (!result.result) {
              yield* save(row, {
                submitFailures: row.submitFailures + 1,
                detail: "Revision submission is not settled",
              });
              return;
            }
            row = yield* save(row, { status: "applying", submitFailures: 0, detail: null });
            continue;
          }
          case "complete": {
            const final = yield* lookup(ctx.project.cwd, row.prUrl);
            const finalHeadSha = final.kind === "found" ? (final.pr?.headSha ?? null) : null;
            const turnId = ctx.submission?.turnId ?? row.applyTurnId;
            const details = turnId
              ? yield* host.getThreadDetails(ctx.thread!.id).pipe(Effect.orElseSucceed(() => null))
              : null;
            const outcome = details
              ? parseUpstreamOutcome(
                  details.messages
                    .filter((message) => message.role === "assistant" && message.turnId === turnId)
                    .map((message) => message.text)
                    .join("\n"),
                )
              : null;
            const command = row.applyCommandJson
              ? (JSON.parse(row.applyCommandJson) as ClientThreadTurnStartCommand)
              : null;
            const detail =
              [
                outcome?.kind === "blocked"
                  ? "Revision blocked: " + outcome.detail
                  : command?.interactionMode === "plan"
                    ? "Revision completed in plan mode"
                    : details && outcome?.kind !== "pr"
                      ? "Revision finished without a PR outcome"
                      : null,
                finalHeadSha && finalHeadSha === row.reviewedHeadSha ? "no new commits" : null,
              ]
                .filter(Boolean)
                .join("; ") || null;
            yield* save(row, {
              status: "completed",
              finalHeadSha,
              detail,
            });
            return;
          }
        }
      }
    });
  const advance = (id: string) => withLock(id, advanceUnlocked(id));
  const reconcile = Effect.gen(function* () {
    const before = new Map(indexVersions);
    const rows = yield* store.listActivePortReviews;
    // Preserve rows indexed while the SQLite snapshot was in flight.
    const present = new Set(rows.map((row) => row.threadId));
    for (const [threadId, version] of before)
      if (!present.has(threadId) && indexVersions.get(threadId) === version) removeIndex(threadId);
    for (const row of rows)
      if (indexVersions.get(row.threadId) === before.get(row.threadId)) index(row);
    yield* Effect.forEach(
      rows,
      (row) => advance(row.threadId).pipe(Effect.ignoreCause({ log: true })),
      { concurrency: 4, discard: true },
    );
  });
  const retry = (projectId: string, threadId: string) =>
    withLock(
      threadId,
      Effect.gen(function* () {
        yield* deps.context(projectId);
        const row = yield* store.getPortReviewByThread(threadId);
        if (!row || row.projectId !== projectId)
          return yield* Effect.fail(new InvalidPortReviewRetry("Port review not found"));
        if (row.status !== "error" && row.status !== "skipped")
          return yield* Effect.fail(
            new InvalidPortReviewRetry("Only failed or skipped reviews can be retried"),
          );
        if (!row.reviewers)
          return yield* Effect.fail(
            new InvalidPortReviewRetry("Invalid stored reviewer settings; start a new port"),
          );
        const ctx = yield* readContext(row);
        // A skipped or ambiguously failed submission may have crossed admission.
        // Keep tracking that exact submission rather than queueing the report twice.
        if (row.applyCommandJson && ctx.thread) {
          const command = JSON.parse(row.applyCommandJson) as ClientThreadTurnStartCommand;
          const previous = yield* host.getSubmission(command.commandId);
          if (previous && !["canceled", "cleared", "rejected"].includes(previous.disposition)) {
            const status = yield* resolveTurnSubmissionStatus(host, {
              thread: ctx.thread,
              submissionId: command.commandId,
              knownTurnId: row.applyTurnId ? TurnId.makeUnsafe(row.applyTurnId) : null,
            });
            // An explicit retry may replace a definitively failed/interrupted turn.
            if (!["failed", "interrupted", "rejected"].includes(status.status)) {
              yield* save(row, { status: "applying", errorStage: null, detail: null });
              yield* advanceUnlocked(threadId);
              return;
            }
          }
        }
        const finished = getFinishedConsumableLatestTurn(ctx.thread);
        const outcome = finished ? parseUpstreamOutcome(finished.assistantText) : null;
        const currentPrUrl =
          (yield* deps.projectedPrUrl(threadId)) ??
          (outcome?.kind === "pr" ? outcome.detail : row.prUrl);
        const reuse =
          row.prUrl &&
          currentPrUrl === row.prUrl &&
          ctx.workflow &&
          !ctx.workflow.deletedAt &&
          deriveCodeReviewWorkflowStatus(ctx.workflow) === "completed" &&
          (row.errorStage === "apply-feedback" || row.status === "skipped");
        // Reusing a completed report still goes through the head check before applying it.
        yield* save(row, {
          status: reuse ? "reviewing" : "waiting",
          attempt: reuse ? row.attempt + 1 : row.attempt,
          reviewWorkflowId: reuse ? row.reviewWorkflowId : null,
          reviewInputJson: reuse ? row.reviewInputJson : null,
          applyCommandJson: null,
          applyTurnId: null,
          submitFailures: 0,
          errorStage: reuse ? "apply-feedback" : null,
          detail: null,
          ...(reuse ? {} : { prUrl: currentPrUrl, reviewedHeadSha: null, finalHeadSha: null }),
        });
        yield* advanceUnlocked(threadId);
      }),
    );
  // Coalesce events so duplicate wakeups for a slow row do not occupy all four workers.
  const eventRuns = new Map<string, { dirty: boolean }>();
  const advanceEvent = (threadId: string) =>
    Effect.suspend(() => {
      const pending = eventRuns.get(threadId);
      if (pending) {
        pending.dirty = true;
        return Effect.void;
      }
      const run = { dirty: false };
      eventRuns.set(threadId, run);
      return Effect.gen(function* () {
        do {
          run.dirty = false;
          yield* advance(threadId).pipe(Effect.ignoreCause({ log: true }));
        } while (run.dirty);
        eventRuns.delete(threadId);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (eventRuns.get(threadId) === run) eventRuns.delete(threadId);
          }),
        ),
      );
    });
  const subscribeSource = <A>(source: Stream.Stream<A>) =>
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(source);
      // toPull is lazy: starting its first pull establishes the source subscription.
      // Preserve that first result while concurrent stream workers start up.
      const first = yield* pull.pipe(Effect.forkScoped({ startImmediately: true }));
      let firstRead = true;
      return Stream.fromPull(
        Effect.succeed(
          Effect.suspend(() => {
            const next = firstRead ? Fiber.join(first) : pull;
            firstRead = false;
            return next;
          }),
        ),
      );
    });
  const subscribe = Effect.gen(function* () {
    const domainEvents = yield* subscribeSource(host.domainEvents);
    const queueChanges = yield* subscribeSource(host.queueChanges);
    return Stream.merge(
      domainEvents.pipe(
        Stream.map((event) => {
          switch (event.type) {
            case "thread.turn-processing-quiesced":
            case "thread.archived":
            case "thread.unarchived":
            case "thread.deleted":
              return activeThreads.get(event.aggregateId) ?? null;
            case "project.code-review-workflow-upserted":
              return activeWorkflows.get(event.payload.workflow.id) ?? null;
            case "project.code-review-workflow-deleted":
              return activeWorkflows.get(event.payload.workflowId) ?? null;
            default:
              return null;
          }
        }),
      ),
      queueChanges.pipe(Stream.map((id) => (applyingThreads.has(id) ? id : null))),
    ).pipe(
      Stream.filter((id): id is string => id !== null),
      Stream.mapEffect(advanceEvent, { concurrency: 4, unordered: true }),
      Stream.runDrain,
    );
  });
  const retryPending = Effect.suspend(() =>
    Effect.forEach(
      [...pendingRetryThreads],
      (threadId) => advance(threadId).pipe(Effect.ignoreCause({ log: true })),
      { concurrency: 4, discard: true },
    ),
  );
  return { advance, reconcile, retry, subscribe, retryPending };
}
