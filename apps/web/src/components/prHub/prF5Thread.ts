import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  type NativeApi,
  type PrHubAdvisory,
  type PrHubLocalCheckoutCandidate,
  ProviderDriverKind,
  type ServerProvider,
  type ThreadId,
  type TrackedPullRequest,
} from "@t3tools/contracts";

import { newCommandId, newMessageId, newThreadId } from "../../lib/utils";

export type PrF5RunKind = "investigation" | "review" | "fix";
export type PrF5Intent = "open" | PrF5RunKind;

export function resolvePrF5RunKind(
  pr: TrackedPullRequest,
  advisory: PrHubAdvisory | undefined,
): PrF5RunKind | null {
  if (pr.state !== "open") return null;

  switch (advisory?.recommendation) {
    case "fix_ci":
    case "wait_for_ci":
      return "investigation";
    case "address_review_feedback":
    case "clarify_feedback":
    case "resolve_conflicts":
      return "fix";
    case "review_requested":
      return "review";
    default:
      break;
  }

  if (pr.checkRollup === "failure" || pr.checkRollup === "error") return "investigation";
  if (
    pr.reviewDecision === "changes_requested" ||
    pr.unresolvedThreadCount > 0 ||
    pr.mergeable === "conflicting"
  ) {
    return "fix";
  }
  if (
    pr.viewerReviewRequested ||
    pr.roles.includes("review_requested") ||
    pr.roles.includes("team_review_requested")
  ) {
    return "review";
  }
  return null;
}

export function prF5RunLabel(kind: PrF5RunKind): string {
  return kind === "review" ? "Review with F5" : "Fix with F5";
}

function advisoryContext(advisory: PrHubAdvisory | undefined): string {
  if (!advisory) return "No generated PR advisory is available; verify the evidence directly.";
  const lines = [
    `Advisory: ${advisory.summary}`,
    ...advisory.blockers.map((blocker) => `Blocker: ${blocker}`),
    ...advisory.findings.slice(0, 20).map((finding) => {
      const author = finding.author ? ` (${finding.author})` : "";
      return `Feedback${author}: ${finding.summary}\nRationale: ${finding.rationale}`;
    }),
  ];
  return lines.join("\n");
}

export function buildPrF5Prompt(input: {
  pr: TrackedPullRequest;
  advisory?: PrHubAdvisory | undefined;
  kind: PrF5RunKind;
}): string {
  const headOid = input.pr.headRefOid;
  if (!headOid) {
    throw new Error("Refresh PR Hub before starting: this pull request has no observed head SHA.");
  }

  const task =
    input.kind === "investigation"
      ? "Investigate the failing CI signal, reproduce the failure locally when possible, identify the root cause, implement the smallest correct fix, and run the relevant quality gates."
      : input.kind === "review"
        ? "Review the pull request at the pinned revision. Focus on correctness, regressions, reliability, security, and missing tests. Do not modify files unless the user explicitly asks you to apply a finding."
        : "Validate the review feedback or merge blocker, implement the smallest correct fix for valid findings, and run the relevant quality gates.";

  return [
    `Work on pull request ${input.pr.url} at the pinned head commit ${headOid}.`,
    `Before doing anything else, run \`git rev-parse HEAD\` and stop if it is not exactly ${headOid}; tell the user to refresh PR Hub instead.`,
    task,
    advisoryContext(input.advisory),
    "Work only in this isolated worktree. Do not commit, push, reply to reviews, approve, close, or merge the pull request. Any Git or GitHub mutation outside the worktree requires explicit user confirmation.",
  ].join("\n\n");
}

export function resolvePrF5ModelSelection(
  providers: readonly ServerProvider[],
  preferredModel: string,
): { model: string; modelSelection: ModelSelection } {
  const available = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "disabled" &&
      provider.status !== "error" &&
      provider.availability !== "unavailable",
  );
  const matchingProvider = available.find((provider) =>
    provider.models.some((model) => model.slug === preferredModel),
  );
  const provider = matchingProvider ?? available[0];
  if (!provider) {
    const model = preferredModel.trim() || DEFAULT_MODEL_BY_PROVIDER.codex;
    return {
      model,
      modelSelection: {
        instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
        model,
      },
    };
  }
  const model =
    provider.models.find((candidate) => candidate.slug === preferredModel)?.slug ??
    provider.models.find((candidate) => !candidate.isCustom)?.slug ??
    provider.models[0]?.slug ??
    (preferredModel.trim() || DEFAULT_MODEL_BY_PROVIDER.codex);
  return {
    model,
    modelSelection: {
      instanceId: provider.instanceId,
      model,
    },
  };
}

export async function createPrF5Thread(input: {
  api: NativeApi;
  candidate: PrHubLocalCheckoutCandidate;
  pr: TrackedPullRequest;
  advisory?: PrHubAdvisory | undefined;
  intent: PrF5Intent;
  preferredModel: string;
  providers: readonly ServerProvider[];
}): Promise<{ threadId: ThreadId; worktreePath: string }> {
  if (input.intent !== "open" && !input.pr.headRefOid) {
    throw new Error("Refresh PR Hub before starting: this pull request has no observed head SHA.");
  }

  const prepared = await input.api.git.preparePullRequestThread({
    cwd: input.candidate.cwd,
    reference: input.pr.url,
    mode: "worktree",
    ...(input.pr.headRefOid ? { expectedHeadOid: input.pr.headRefOid } : {}),
  });
  if (!prepared.worktreePath) {
    throw new Error("F5 did not create an isolated worktree for this pull request.");
  }

  const threadId = newThreadId();
  const createdAt = new Date().toISOString();
  const title = `PR #${input.pr.number}: ${input.pr.title}`;
  const { model, modelSelection } = resolvePrF5ModelSelection(
    input.providers,
    input.preferredModel,
  );

  if (input.intent === "open") {
    await input.api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: input.candidate.projectId,
      title,
      model,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: prepared.branch,
      worktreePath: prepared.worktreePath,
      createdAt,
    });
  } else {
    await input.api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      commandId: newCommandId(),
      threadId,
      message: {
        messageId: newMessageId(),
        role: "user",
        text: buildPrF5Prompt({
          pr: input.pr,
          advisory: input.advisory,
          kind: input.intent,
        }),
        attachments: [],
      },
      model,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: input.candidate.projectId,
          title,
          model,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: prepared.branch,
          worktreePath: prepared.worktreePath,
          createdAt,
        },
      },
      createdAt,
    });
  }

  return { threadId, worktreePath: prepared.worktreePath };
}
