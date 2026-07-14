import { Effect } from "effect";

import type { GitCoreShape, GitStatusDetails } from "./Services/GitCore.ts";
import type { GitHubCliShape, GitHubPullRequestSummary } from "./Services/GitHubCli.ts";
import type { TextGenerationShape } from "./Services/TextGeneration.ts";

type MethodCalls<T> = {
  readonly [K in keyof T]: ReadonlyArray<ReadonlyArray<unknown>>;
};

const DEFAULT_STATUS_DETAILS: GitStatusDetails = {
  branch: "feature/test",
  upstreamRef: "origin/feature/test",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
};

export function makeFakeGitCore(overrides: Partial<GitCoreShape> = {}): {
  readonly service: GitCoreShape;
  readonly calls: MethodCalls<GitCoreShape>;
} {
  const recorded = Object.fromEntries(
    [
      "status",
      "statusDetails",
      "prepareCommitContext",
      "commit",
      "pushCurrentBranch",
      "readRangeContext",
      "readConfigValue",
      "listBranches",
      "pullCurrentBranch",
      "createWorktree",
      "fetchPullRequestBranch",
      "ensureRemote",
      "fetchRemoteBranch",
      "setBranchUpstream",
      "removeWorktree",
      "renameBranch",
      "createBranch",
      "checkoutBranch",
      "initRepo",
      "listLocalBranchNames",
    ].map((method) => [method, []]),
  ) as unknown as { [K in keyof GitCoreShape]: Array<ReadonlyArray<unknown>> };

  const implementations: GitCoreShape = {
    status: (_input) =>
      Effect.succeed({
        ...DEFAULT_STATUS_DETAILS,
        upstreamRef: undefined,
        pr: null,
        changeRequest: null,
      }),
    statusDetails: () => Effect.succeed(DEFAULT_STATUS_DETAILS),
    prepareCommitContext: () => Effect.succeed(null),
    commit: () => Effect.succeed({ commitSha: "abc123" }),
    pushCurrentBranch: (_cwd, fallbackBranch) =>
      Effect.succeed({
        status: "pushed",
        branch: fallbackBranch ?? "feature/test",
        upstreamBranch: `origin/${fallbackBranch ?? "feature/test"}`,
        setUpstream: false,
      }),
    readRangeContext: () =>
      Effect.succeed({ commitSummary: "abc change", diffSummary: "1 file", diffPatch: "+change" }),
    readConfigValue: () => Effect.succeed(null),
    listBranches: () => Effect.succeed({ branches: [], isRepo: true, hasOriginRemote: true }),
    pullCurrentBranch: () =>
      Effect.succeed({
        status: "skipped_up_to_date",
        branch: "feature/test",
        upstreamBranch: "origin/feature/test",
      }),
    createWorktree: (input) =>
      Effect.succeed({
        worktree: {
          path: input.path ?? "/tmp/f5-test-worktree",
          branch: input.newBranch ?? input.branch,
        },
      }),
    fetchPullRequestBranch: () => Effect.void,
    ensureRemote: (input) => Effect.succeed(input.preferredName),
    fetchRemoteBranch: () => Effect.void,
    setBranchUpstream: () => Effect.void,
    removeWorktree: () => Effect.void,
    renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
    createBranch: () => Effect.void,
    checkoutBranch: () => Effect.void,
    initRepo: () => Effect.void,
    listLocalBranchNames: () => Effect.succeed([]),
    ...overrides,
  };

  const record = <K extends keyof GitCoreShape>(method: K, args: ReadonlyArray<unknown>) => {
    recorded[method].push(args);
  };

  const service: GitCoreShape = {
    status: (input) => {
      record("status", [input]);
      return implementations.status(input);
    },
    statusDetails: (cwd) => {
      record("statusDetails", [cwd]);
      return implementations.statusDetails(cwd);
    },
    prepareCommitContext: (cwd, filePaths) => {
      record("prepareCommitContext", [cwd, filePaths]);
      return implementations.prepareCommitContext(cwd, filePaths);
    },
    commit: (cwd, subject, body) => {
      record("commit", [cwd, subject, body]);
      return implementations.commit(cwd, subject, body);
    },
    pushCurrentBranch: (cwd, fallbackBranch) => {
      record("pushCurrentBranch", [cwd, fallbackBranch]);
      return implementations.pushCurrentBranch(cwd, fallbackBranch);
    },
    readRangeContext: (cwd, baseBranch) => {
      record("readRangeContext", [cwd, baseBranch]);
      return implementations.readRangeContext(cwd, baseBranch);
    },
    readConfigValue: (cwd, key) => {
      record("readConfigValue", [cwd, key]);
      return implementations.readConfigValue(cwd, key);
    },
    listBranches: (input) => {
      record("listBranches", [input]);
      return implementations.listBranches(input);
    },
    pullCurrentBranch: (cwd) => {
      record("pullCurrentBranch", [cwd]);
      return implementations.pullCurrentBranch(cwd);
    },
    createWorktree: (input) => {
      record("createWorktree", [input]);
      return implementations.createWorktree(input);
    },
    fetchPullRequestBranch: (input) => {
      record("fetchPullRequestBranch", [input]);
      return implementations.fetchPullRequestBranch(input);
    },
    ensureRemote: (input) => {
      record("ensureRemote", [input]);
      return implementations.ensureRemote(input);
    },
    fetchRemoteBranch: (input) => {
      record("fetchRemoteBranch", [input]);
      return implementations.fetchRemoteBranch(input);
    },
    setBranchUpstream: (input) => {
      record("setBranchUpstream", [input]);
      return implementations.setBranchUpstream(input);
    },
    removeWorktree: (input) => {
      record("removeWorktree", [input]);
      return implementations.removeWorktree(input);
    },
    renameBranch: (input) => {
      record("renameBranch", [input]);
      return implementations.renameBranch(input);
    },
    createBranch: (input) => {
      record("createBranch", [input]);
      return implementations.createBranch(input);
    },
    checkoutBranch: (input) => {
      record("checkoutBranch", [input]);
      return implementations.checkoutBranch(input);
    },
    initRepo: (input) => {
      record("initRepo", [input]);
      return implementations.initRepo(input);
    },
    listLocalBranchNames: (cwd) => {
      record("listLocalBranchNames", [cwd]);
      return implementations.listLocalBranchNames(cwd);
    },
  };

  return { service, calls: recorded };
}

export interface FakeGitHubCliOptions {
  readonly pullRequests?: ReadonlyArray<GitHubPullRequestSummary>;
  readonly pullRequestSequence?: ReadonlyArray<ReadonlyArray<GitHubPullRequestSummary>>;
  readonly pullRequest?: GitHubPullRequestSummary;
  readonly defaultBranch?: string | null;
}

export function makeFakeGitHubCli(options: FakeGitHubCliOptions = {}): {
  readonly service: GitHubCliShape;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const pullRequestSequence = [...(options.pullRequestSequence ?? [])];
  const pullRequest = options.pullRequest ?? {
    number: 42,
    title: "Test pull request",
    url: "https://github.com/t3tools/f5/pull/42",
    baseRefName: "main",
    headRefName: "feature/test",
    headRefOid: "feedface",
    state: "open",
  };
  const processResult = { code: 0, stdout: "[]\n", stderr: "", signal: null, timedOut: false };

  const service: GitHubCliShape = {
    execute: (input) => {
      calls.push(`execute:${input.args.join(" ")}`);
      const pullRequests = (options.pullRequests ?? []).map((pullRequest) => ({
        ...pullRequest,
        ...(pullRequest.state ? { state: pullRequest.state.toUpperCase() } : {}),
      }));
      return Effect.succeed({
        ...processResult,
        stdout: JSON.stringify(pullRequests) + "\n",
      });
    },
    listOpenPullRequests: (input) => {
      calls.push(`listOpenPullRequests:${input.headSelector}`);
      return Effect.succeed(pullRequestSequence.shift() ?? options.pullRequests ?? []);
    },
    getPullRequest: (input) => {
      calls.push(`getPullRequest:${input.reference}`);
      return Effect.succeed(pullRequest);
    },
    getRepositoryCloneUrls: (input) => {
      calls.push(`getRepositoryCloneUrls:${input.repository}`);
      return Effect.succeed({
        nameWithOwner: input.repository,
        url: `https://github.com/${input.repository}.git`,
        sshUrl: `git@github.com:${input.repository}.git`,
      });
    },
    createPullRequest: (input) => {
      calls.push(`createPullRequest:${input.baseBranch}:${input.headSelector}`);
      return Effect.void;
    },
    getDefaultBranch: () => {
      calls.push("getDefaultBranch");
      return Effect.succeed(options.defaultBranch === undefined ? "main" : options.defaultBranch);
    },
    checkoutPullRequest: (input) => {
      calls.push(`checkoutPullRequest:${input.reference}`);
      return Effect.void;
    },
    getAuthenticatedLogin: () => Effect.succeed("test-user"),
    getViewerTeams: () => Effect.succeed([]),
    runGraphql: () => Effect.succeed({}),
    searchPullRequests: () => Effect.succeed([]),
    reviewPullRequest: () => Effect.void,
    requestChanges: () => Effect.void,
    commentPullRequest: () => Effect.void,
    mergePullRequest: () => Effect.void,
    markPullRequestReady: () => Effect.void,
    addPullRequestReviewers: () => Effect.void,
  };

  return { service, calls };
}

export function makeFakeTextGeneration(
  overrides: Partial<TextGenerationShape> = {},
): TextGenerationShape {
  return {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Generated commit",
        body: "Generated body",
        ...(input.includeBranch ? { branch: "feature/generated-commit" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({ title: "Generated pull request", body: "Generated body" }),
    generateBranchName: () => Effect.succeed({ branch: "feature/generated" }),
    generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
    generateStructuredJson: () => Effect.die("generateStructuredJson is not used by Git tests"),
    ...overrides,
  };
}
