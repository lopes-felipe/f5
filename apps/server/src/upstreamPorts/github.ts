/**
 * The GitHub operations upstream ports need: the rolling ledger PR and
 * upstream PR bodies for triage digests. Every call names its repository and
 * uses the profile's GitHub credential, so the ledger PR always targets the
 * `origin` repository whatever other remotes exist.
 *
 * @module upstreamPorts/github
 */
import { Data, Effect } from "effect";

import type { GitHubCliError } from "../git/Errors.ts";
import type { GitHubApiRequest, GitHubApiResponse } from "../git/githubApi.ts";
import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";

export interface LedgerPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
}

export interface GitHubRepoRef {
  readonly owner: string;
  readonly name: string;
}

export class UpstreamGitHubError extends Data.TaggedError("UpstreamGitHubError")<{
  readonly operation: string;
  readonly detail: string;
  /** Network, timeout, rate-limit or server failures that may succeed later. */
  readonly transient: boolean;
}> {
  override get message(): string {
    return this.detail;
  }
}

export interface UpstreamGitHub {
  /**
   * Whether the profile has a usable GitHub credential. Fails only with
   * transient errors; a missing or rejected credential is `false`.
   */
  readonly available: (cwd: string) => Effect.Effect<boolean, UpstreamGitHubError>;
  /** PR `number` in `repo`, or null when it does not exist. */
  readonly findPullRequest: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly number: number;
  }) => Effect.Effect<LedgerPullRequest | null, UpstreamGitHubError>;
  /** The newest PR in `repo` whose head is `repo`'s `branch`, or null. */
  readonly findPullRequestForBranch: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly branch: string;
  }) => Effect.Effect<LedgerPullRequest | null, UpstreamGitHubError>;
  /** Opens a PR from `repo`'s `head` branch into its `base` branch. */
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }) => Effect.Effect<LedgerPullRequest, UpstreamGitHubError>;
  readonly updatePullRequestBody: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly number: number;
    readonly body: string;
  }) => Effect.Effect<void, UpstreamGitHubError>;
  readonly closePullRequest: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly number: number;
  }) => Effect.Effect<void, UpstreamGitHubError>;
  /** PR bodies keyed by number; numbers that cannot be read are omitted. */
  readonly fetchPullRequestBodies: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly numbers: ReadonlyArray<number>;
  }) => Effect.Effect<Map<number, string>, UpstreamGitHubError>;
}

export function parseGitHubRepo(url: string): GitHubRepoRef | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
      url.trim(),
    );
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

export const PR_BODY_BATCH = 50;

const GITHUB_HOST = "github.com";
const TRANSIENT_KINDS = new Set(["network", "timeout", "rate_limited"]);

const cliFailure = (operation: string, error: GitHubCliError) =>
  new UpstreamGitHubError({
    operation,
    detail: error.detail,
    transient: TRANSIENT_KINDS.has(error.kind ?? ""),
  });

const isRateLimited = (response: GitHubApiResponse) =>
  response.status === 429 ||
  (response.status === 403 &&
    (response.rateLimit.remaining === 0 || response.rateLimit.retryAfterSeconds != null));

const statusFailure = (operation: string, response: GitHubApiResponse) => {
  const message = (response.body as { message?: unknown } | null)?.message;
  return new UpstreamGitHubError({
    operation,
    detail: `GitHub ${operation} failed (${response.status})${typeof message === "string" ? `: ${message}` : ""}.`,
    transient: response.status >= 500 || isRateLimited(response),
  });
};

const toPullRequest = (operation: string, value: unknown) => {
  const raw = (value ?? {}) as {
    number?: unknown;
    html_url?: unknown;
    state?: unknown;
    merged_at?: unknown;
  };
  if (typeof raw.number !== "number" || typeof raw.html_url !== "string")
    return Effect.fail(
      new UpstreamGitHubError({
        operation,
        detail: "GitHub returned an invalid pull request.",
        transient: false,
      }),
    );
  return Effect.succeed<LedgerPullRequest>({
    number: raw.number,
    url: raw.html_url,
    state: raw.merged_at ? "merged" : raw.state === "closed" ? "closed" : "open",
  });
};

const repoPath = (repo: GitHubRepoRef) =>
  `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

export function makeUpstreamGitHub(cli: GitHubCliShape): UpstreamGitHub {
  const send = (
    operation: string,
    cwd: string,
    request: Omit<GitHubApiRequest, "cwd" | "context">,
  ) =>
    Effect.gen(function* () {
      const context = yield* cli
        .getCredentialContext({ cwd, host: GITHUB_HOST })
        .pipe(Effect.mapError((error) => cliFailure(operation, error)));
      return yield* cli
        .request({ cwd, context, timeoutMs: 30_000, ...request })
        .pipe(Effect.mapError((error) => cliFailure(operation, error)));
    });

  const available: UpstreamGitHub["available"] = (cwd) =>
    cli.getCredentialContext({ cwd, host: GITHUB_HOST }).pipe(
      Effect.as(true),
      Effect.catch((error) => {
        const failure = cliFailure("credentials", error);
        return failure.transient ? Effect.fail(failure) : Effect.succeed(false);
      }),
    );

  const findPullRequest: UpstreamGitHub["findPullRequest"] = (input) =>
    Effect.gen(function* () {
      const response = yield* send("pull request lookup", input.cwd, {
        method: "GET",
        endpoint: `${repoPath(input.repo)}/pulls/${input.number}`,
      });
      if (response.status === 404) return null;
      if (response.status !== 200) return yield* statusFailure("pull request lookup", response);
      return yield* toPullRequest("pull request lookup", response.body);
    });

  const findPullRequestForBranch: UpstreamGitHub["findPullRequestForBranch"] = (input) =>
    Effect.gen(function* () {
      const response = yield* send("pull request lookup", input.cwd, {
        method: "GET",
        endpoint: `${repoPath(input.repo)}/pulls`,
        query: {
          head: `${input.repo.owner}:${input.branch}`,
          state: "all",
          sort: "created",
          direction: "desc",
          per_page: 1,
        },
      });
      if (response.status === 404) return null;
      if (response.status !== 200) return yield* statusFailure("pull request lookup", response);
      const first = Array.isArray(response.body) ? response.body[0] : undefined;
      return first === undefined ? null : yield* toPullRequest("pull request lookup", first);
    });

  const createPullRequest: UpstreamGitHub["createPullRequest"] = (input) =>
    Effect.gen(function* () {
      const response = yield* send("pull request creation", input.cwd, {
        method: "POST",
        endpoint: `${repoPath(input.repo)}/pulls`,
        body: { title: input.title, head: input.head, base: input.base, body: input.body },
      });
      if (response.status !== 201) return yield* statusFailure("pull request creation", response);
      return yield* toPullRequest("pull request creation", response.body);
    });

  const patchPullRequest = (
    operation: string,
    input: { readonly cwd: string; readonly repo: GitHubRepoRef; readonly number: number },
    body: Record<string, string>,
  ) =>
    Effect.gen(function* () {
      const response = yield* send(operation, input.cwd, {
        method: "PATCH",
        endpoint: `${repoPath(input.repo)}/pulls/${input.number}`,
        body,
      });
      if (response.status !== 200) return yield* statusFailure(operation, response);
    });

  const updatePullRequestBody: UpstreamGitHub["updatePullRequestBody"] = (input) =>
    patchPullRequest("pull request update", input, { body: input.body });

  const closePullRequest: UpstreamGitHub["closePullRequest"] = (input) =>
    patchPullRequest("pull request close", input, { state: "closed" });

  const fetchPullRequestBodies: UpstreamGitHub["fetchPullRequestBodies"] = (input) =>
    Effect.gen(function* () {
      const out = new Map<number, string>();
      const unique = [...new Set(input.numbers)];
      for (let start = 0; start < unique.length; start += PR_BODY_BATCH) {
        const batch = unique.slice(start, start + PR_BODY_BATCH);
        const fields = batch
          .map((number) => `p${number}: pullRequest(number: ${number}) { body }`)
          .join("\n");
        const response = yield* cli
          .runGraphql({
            cwd: input.cwd,
            query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
            variables: { owner: input.repo.owner, name: input.repo.name },
          })
          .pipe(Effect.mapError((error) => cliFailure("pull request bodies", error)));
        const repository = (
          response as { data?: { repository?: Record<string, { body?: unknown } | null> } }
        )?.data?.repository;
        for (const number of batch) {
          const body = repository?.[`p${number}`]?.body;
          if (typeof body === "string") out.set(number, body);
        }
      }
      return out;
    });

  return {
    available,
    findPullRequest,
    findPullRequestForBranch,
    createPullRequest,
    updatePullRequestBody,
    closePullRequest,
    fetchPullRequestBodies,
  };
}
