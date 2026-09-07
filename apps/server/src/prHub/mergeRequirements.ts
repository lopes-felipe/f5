import { Effect, Schema } from "effect";
import type { PrHubMergeRequirements } from "@t3tools/contracts";
import type { GitHubApiResponse } from "../git/githubApi.ts";
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const unknownMergeRequirements = (
  explanation = "Refresh the PR to verify required checks and effective branch rules.",
): PrHubMergeRequirements => ({
  verification: "unknown",
  mandatorySatisfied: false,
  explanation,
  checks: [],
  ruleTypes: [],
});
export const PR_HUB_BRANCH_REQUIREMENTS_FIELDS = `baseRef { branchProtectionRule { requiredStatusChecks { context app { databaseId } } requiresConversationResolution } }`;
const Rules = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
/** GitHub's branch-rules endpoint includes active repository and organization rulesets. */
export function readMergeRequirements<E, R>(
  node: Record<string, unknown>,
  read: (
    endpoint: string,
    query: Record<string, string | number | boolean>,
  ) => Effect.Effect<GitHubApiResponse, E, R>,
) {
  return Effect.gen(function* () {
    const repository = record(node.repository)?.nameWithOwner;
    const branch = node.baseRefName;
    if (typeof repository !== "string" || typeof branch !== "string")
      return unknownMergeRequirements();
    const rules: (typeof Rules.Type)[number][] = [];
    for (let page = 1; page <= 10; page++) {
      const response = yield* read(
        `repos/${repository.split("/").map(encodeURIComponent).join("/")}/rules/branches/${encodeURIComponent(branch)}`,
        { per_page: 100, page },
      );
      if (response.status !== 200 || !Schema.is(Rules)(response.body))
        return unknownMergeRequirements(
          "Effective branch rules could not be verified. Check repository access and refresh.",
        );
      rules.push(...response.body);
      if (!response.links.next && response.body.length < 100)
        return evaluateMergeRequirements(node, rules);
    }
    return unknownMergeRequirements(
      "Effective branch rule traversal is incomplete. Refresh to retry.",
    );
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        unknownMergeRequirements(
          "Effective branch rules could not be verified. Refresh when GitHub is available.",
        ),
      ),
    ),
  );
}
export function evaluateMergeRequirements(
  node: Record<string, unknown>,
  rules: typeof Rules.Type,
): PrHubMergeRequirements {
  const base = record(node.baseRef);
  if (!base || !("branchProtectionRule" in base))
    return unknownMergeRequirements(
      "Legacy branch protection is unverified. Refresh before merging.",
    );
  const protection = record(base.branchProtectionRule);
  if (
    base.branchProtectionRule !== null &&
    (!protection || !Array.isArray(protection.requiredStatusChecks))
  )
    return unknownMergeRequirements("Required checks are unavailable. Refresh before merging.");
  const required: { name: string; appId: number | null }[] = [];
  for (const raw of array(protection?.requiredStatusChecks)) {
    const check = record(raw);
    if (typeof check?.context !== "string") return unknownMergeRequirements();
    const app = record(check.app);
    if (app && typeof app.databaseId !== "number") return unknownMergeRequirements();
    required.push({ name: check.context, appId: (app?.databaseId as number) ?? null });
  }
  let resolve = protection?.requiresConversationResolution === true;
  for (const rule of rules) {
    if (rule.type === "required_status_checks") {
      if (!Array.isArray(rule.parameters?.required_status_checks))
        return unknownMergeRequirements("Required check rules were incomplete.");
      for (const raw of rule.parameters.required_status_checks) {
        const check = record(raw);
        if (
          typeof check?.context !== "string" ||
          (check.integration_id !== null &&
            check.integration_id !== undefined &&
            typeof check.integration_id !== "number")
        )
          return unknownMergeRequirements();
        required.push({
          name: check.context,
          appId:
            typeof check.integration_id === "number" && check.integration_id > 0
              ? check.integration_id
              : null,
        });
      }
    }
    if (rule.type === "pull_request" && rule.parameters?.required_review_thread_resolution === true)
      resolve = true;
  }
  const commit = record(record(array(record(node.commits)?.nodes).at(-1))?.commit);
  const contexts = record(record(commit?.statusCheckRollup)?.contexts);
  const available = array(contexts?.nodes)
    .map(record)
    .filter((item) => item !== null);
  const complete =
    contexts?.totalCount === available.length && record(contexts?.pageInfo)?.hasNextPage === false;
  const checks: PrHubMergeRequirements["checks"][number][] = [
    ...new Map(required.map((item) => [JSON.stringify(item), item])).values(),
  ].map((required) => {
    const matches = available.filter(
      (item) =>
        (item.name ?? item.context) === required.name &&
        (required.appId === null ||
          record(record(item.checkSuite)?.app)?.databaseId === required.appId),
    );
    const states = matches.map((item) =>
      typeof item.conclusion === "string" ? item.conclusion : (item.state ?? item.status),
    );
    const state = !complete
      ? "unknown"
      : !matches.length
        ? "missing"
        : states.some((state) =>
              [
                "FAILURE",
                "ERROR",
                "TIMED_OUT",
                "CANCELLED",
                "ACTION_REQUIRED",
                "STARTUP_FAILURE",
                "STALE",
              ].includes(String(state)),
            )
          ? "failure"
          : states.every((state) => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(state)))
            ? "success"
            : "pending";
    const url = matches[0]?.detailsUrl ?? matches[0]?.targetUrl;
    return { ...required, state, url: typeof url === "string" ? url : null };
  });
  const threadConnection = record(node.reviewThreads);
  const threads = array(threadConnection?.nodes).map(record);
  const threadCount =
    typeof threadConnection?.unresolvedCount === "number"
      ? threadConnection.unresolvedCount
      : threads.filter((thread) => thread?.isResolved !== true).length;
  const threadsComplete =
    node.reviewFactsComplete === true ||
    (record(threadConnection?.pageInfo)?.hasNextPage === false &&
      threadConnection?.totalCount === threads.length);
  const unknown =
    checks.some((check) => check.state === "unknown") || (resolve && !threadsComplete);
  const satisfied =
    !unknown &&
    checks.every((check) => check.state === "success") &&
    (!resolve || threadCount === 0) &&
    node.mergeable === "MERGEABLE" &&
    node.mergeStateStatus === "CLEAN" &&
    !rules.some((rule) => rule.type === "merge_queue");
  return {
    verification: unknown ? "unknown" : "verified",
    mandatorySatisfied: satisfied,
    checks,
    ruleTypes: [...new Set(rules.map((rule) => rule.type))].sort(),
    explanation: unknown
      ? "Required-check or review-thread evidence is incomplete. Refresh before merging."
      : satisfied
        ? "GitHub's effective branch requirements are satisfied."
        : checks.some((check) => check.state !== "success")
          ? "Required checks are failing, pending, or missing. Inspect the required checks before merging."
          : resolve && threadCount > 0
            ? "Resolve all mandatory review conversations before merging."
            : "GitHub's effective branch requirements still block merging. Inspect the PR rules on GitHub.",
  };
}

export const isBranchRulePage = Schema.is(Rules);
