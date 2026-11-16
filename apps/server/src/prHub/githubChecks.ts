import { Effect } from "effect";
import type { PrHubCheckRun } from "@t3tools/contracts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { record, text } from "./forgeModel.ts";
import { checkOf } from "./githubPrDetails.ts";

/** Three pages of a hundred: enough for a large matrix without an unbounded read. */
export const GITHUB_CHECKS_MAX_PAGES = 3;

export const GITHUB_CHECKS_QUERY = `query F5PullRequestChecks($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefOid
      commits(last:1){ nodes { commit { statusCheckRollup { contexts(first:100,after:$cursor){
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CheckRun {
            databaseId name status conclusion detailsUrl startedAt completedAt
            isRequired(pullRequestNumber:$number)
            checkSuite { app { slug } workflowRun { databaseId workflow { name } } }
          }
          ... on StatusContext { context state description targetUrl createdAt isRequired(pullRequestNumber:$number) }
        }
      } } } } }
    }
  }
}`;

const invalid = (detail: string) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "prHub.checks",
    kind: "invalid_response",
    detail,
  });

const isoOf = (value: unknown): string | null => {
  const raw = text(value);
  return raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
};

const idOf = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;

/** A GitHub Actions job is a check run with the same ID; only those have a log to read. */
export function gitHubCheckRunOf(value: unknown, index: number): PrHubCheckRun | null {
  const node = record(value);
  const check = checkOf(node);
  if (!check) return null;
  if (node.__typename !== "CheckRun")
    return {
      ...check,
      id: `status:${check.name}`,
      workflow: null,
      workflowRunId: null,
      startedAt: isoOf(node.createdAt),
      completedAt: null,
      logAvailable: false,
    };
  const suite = record(node.checkSuite);
  const run = record(suite.workflowRun);
  const jobId = idOf(node.databaseId);
  const workflowRunId = idOf(run.databaseId);
  return {
    ...check,
    // A check run's description is its conclusion again, which the status already says.
    description: null,
    id: jobId ?? `run:${index}`,
    workflow: text(record(run.workflow).name),
    workflowRunId,
    startedAt: isoOf(node.startedAt),
    completedAt: isoOf(node.completedAt),
    logAvailable:
      jobId !== null &&
      workflowRunId !== null &&
      record(suite.app).slug === "github-actions" &&
      check.status !== "pending",
  };
}

export interface GitHubChecks {
  readonly headOid: string | null;
  readonly checks: ReadonlyArray<PrHubCheckRun>;
  readonly truncated: boolean;
}

/** Reads the head commit's checks a page at a time, up to the page limit. */
export const readGitHubChecks = <E>(
  query: (cursor: string | null) => Effect.Effect<unknown, E>,
): Effect.Effect<GitHubChecks, E | SourceControlProviderError> =>
  Effect.gen(function* () {
    const checks: PrHubCheckRun[] = [];
    let headOid: string | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < GITHUB_CHECKS_MAX_PAGES; page++) {
      const body = record(yield* query(cursor));
      if (Array.isArray(body.errors) && body.errors.length > 0)
        return yield* invalid("GitHub rejected the checks read.");
      const pullRequest = record(record(body.data).repository).pullRequest;
      if (!pullRequest || typeof pullRequest !== "object")
        return yield* invalid("GitHub did not return the pull request.");
      const pr = record(pullRequest);
      const head = text(pr.headRefOid);
      // A push between two pages would mix the checks of two commits.
      if (page > 0 && head !== headOid)
        return yield* invalid("The pull request changed while its checks were read.");
      headOid = head;
      const commits = record(pr.commits).nodes;
      const commit = record(Array.isArray(commits) ? record(commits[0]).commit : null);
      const contexts = record(record(commit.statusCheckRollup).contexts);
      const nodes = Array.isArray(contexts.nodes) ? contexts.nodes : [];
      for (const node of nodes) {
        const check = gitHubCheckRunOf(node, checks.length);
        if (check) checks.push(check);
      }
      const pageInfo = record(contexts.pageInfo);
      if (pageInfo.hasNextPage !== true) return { headOid, checks, truncated: false };
      const next = text(pageInfo.endCursor);
      if (!next || next === cursor) return yield* invalid("GitHub returned an invalid cursor.");
      cursor = next;
    }
    return { headOid, checks, truncated: true };
  });

const RERUNNABLE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out"]);

/** A workflow run as far as a re-run needs to know it. */
export interface GitHubWorkflowRun {
  readonly id: number;
  /** Starts at 1 and goes up each time the run is run again. */
  readonly attempt: number;
  readonly completed: boolean;
}

export interface GitHubFailedWorkflowRuns {
  /**
   * The current run of each workflow at the commit, when it finished and failed, was
   * cancelled or timed out.
   */
  readonly runs: ReadonlyArray<GitHubWorkflowRun>;
  /** How many workflow runs the commit has. */
  readonly total: number;
  /** False when the listing is malformed or has more runs than one page holds. */
  readonly complete: boolean;
}

const positiveInt = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/** Reads one run of the Actions API; null when it is not a workflow run. */
export function gitHubWorkflowRunOf(value: unknown): GitHubWorkflowRun | null {
  const run = record(value);
  const id = positiveInt(run.id);
  if (id === null || typeof run.status !== "string") return null;
  return { id, attempt: positiveInt(run.run_attempt) ?? 1, completed: run.status === "completed" };
}

/**
 * Picks the workflow runs "re-run failed jobs" applies to from a commit's run listing.
 * A commit can hold several runs of one workflow: a newer run replaces an older one, and
 * cancels it when the workflow has a concurrency group. Only the newest run of a workflow
 * and event counts. Starting a replaced run again would cancel the run that replaced it.
 */
export function failedGitHubWorkflowRuns(body: unknown, headOid: string): GitHubFailedWorkflowRuns {
  const listing = record(body);
  const listed = Array.isArray(listing.workflow_runs) ? listing.workflow_runs.map(record) : null;
  if (!listed) return { runs: [], total: 0, complete: false };
  let complete = Number(listing.total_count) <= listed.length;
  const newest = new Map<string, Record<string, unknown>>();
  for (const run of listed) {
    if (run.head_sha !== headOid) continue;
    const id = positiveInt(run.id);
    if (id === null) {
      complete = false;
      continue;
    }
    // A run that does not name its workflow stands alone.
    const workflow = positiveInt(run.workflow_id);
    const slot = workflow === null ? `run:${id}` : `${workflow}:${String(run.event)}`;
    const current = newest.get(slot);
    const order = (value: Record<string, unknown>) => [
      positiveInt(value.run_number) ?? 0,
      positiveInt(value.id) ?? 0,
    ];
    const [number, runId] = order(run);
    const [currentNumber, currentId] = current ? order(current) : [-1, -1];
    if (number! > currentNumber! || (number === currentNumber && runId! > currentId!))
      newest.set(slot, run);
  }
  const runs: GitHubWorkflowRun[] = [];
  for (const value of newest.values()) {
    const run = gitHubWorkflowRunOf(value);
    if (run?.completed && RERUNNABLE_CONCLUSIONS.has(String(value.conclusion))) runs.push(run);
  }
  return { runs, total: listed.length, complete };
}
