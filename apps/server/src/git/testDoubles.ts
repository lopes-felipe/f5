import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads";
import { Effect, Layer, Option } from "effect";

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
      "readMoveSnapshot",
      "copyMoveUntracked",
      "stashCreate",
      "stashApplySha",
      "stashPushAll",
      "setMoveRef",
      "deleteMoveRef",
      "cleanMoveCopies",
      "status",
      "statusDetails",
      "cleanupSafetyProbe",
      "prepareCommitContext",
      "commit",
      "commitPrepared",
      "pushCurrentBranch",
      "branchExists",
      "ensureWorktree",
      "allocateWorktreePath",
      "readWorktreePreparation",
      "resolveAvailableBranchName",
      "isValidBranchName",
      "fastForwardTo",
      "initializeWorktreeSubmodules",
      "listWorktrees",
      "isDirty",
      "inspectCheckout",
      "inspectCheckoutIdentity",
      "resolveCheckoutTarget",
      "clearMissingRegistration",
      "readRangeContext",
      "readDefaultBranch",
      "readConfigValue",
      "listRemotes",
      "listBranches",
      "pullCurrentBranch",
      "createWorktree",
      "hasRemote",
      "fetchRemoteBranchCommit",
      "fetchPullRequestBranch",
      "ensureRemote",
      "fetchRemoteBranch",
      "setBranchUpstream",
      "removeWorktree",
      "resolveCommonDir",
      "pruneWorktrees",
      "resolveCommit",
      "readOperationInProgress",
      "isAncestor",
      "deleteBranchIfAt",
      "readFileAtRevision",
      "listIgnoredEntries",
      "renameBranch",
      "createBranch",
      "checkoutBranch",
      "initRepo",
      "cloneRepository",
      "listLocalBranchNames",
    ].map((method) => [method, []]),
  ) as unknown as { [K in keyof GitCoreShape]-?: Array<ReadonlyArray<unknown>> };

  const implementations: GitCoreShape = {
    readMoveSnapshot: () =>
      Effect.succeed({
        baseSha: "abc123",
        trackedStashSha: null,
        trackedTree: null,
        indexTree: null,
        untracked: [],
        copiedFileCount: 0,
      }),
    copyMoveUntracked: () => Effect.void,
    stashCreate: () => Effect.succeed(null),
    stashApplySha: () => Effect.void,
    stashPushAll: () => Effect.void,
    setMoveRef: () => Effect.void,
    deleteMoveRef: () => Effect.void,
    cleanMoveCopies: () => Effect.void,
    isDirty: () => Effect.succeed(false),
    cleanupSafetyProbe: () =>
      Effect.succeed({
        hasTrackedChanges: false,
        hasUntrackedChanges: false,
        ignoredEntries: [],
        ignoredTruncated: false,
      }),
    readWorktreePreparation: () => Effect.succeed(null),
    allocateWorktreePath: ({ cwd, branch }) =>
      Effect.succeed(`${cwd}/worktrees/${branch.replaceAll("/", "-")}`),
    resolveAvailableBranchName: (_cwd, name) => Effect.succeed(name),
    isValidBranchName: () => Effect.succeed(true),
    cloneRepository: () => Effect.void,
    fastForwardTo: () => Effect.void,
    initializeWorktreeSubmodules: () => Effect.void,
    branchExists: () => Effect.succeed(true),
    ensureWorktree: () => Effect.succeed({ recreated: false }),
    listWorktrees: () => Effect.succeed([]),
    clearMissingRegistration: () => Effect.void,
    inspectCheckoutIdentity: (path) => implementations.inspectCheckout(path),
    resolveCheckoutTarget: (input) =>
      Effect.succeed({
        branch: input.branch,
        headSha: "abc123",
        checkoutArgs: ["checkout", input.branch],
      }),
    inspectCheckout: (path) =>
      Effect.succeed({
        canonicalRoot: path,
        commonDir: `${path}/.git`,
        registration: null,
        headSha: "abc123",
        branch: "feature/test",
        operation: null,
        hasInitializedSubmodules: false,
        hasTrackedChanges: false,
        hasUntrackedChanges: false,
        ignoredEntries: [],
        ignoredTruncated: false,
        upstreamRef: null,
        upstreamSha: null,
        aheadCount: null,
        behindCount: null,
      }),
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
    commitPrepared: () => Effect.succeed({ status: "created", commitSha: "abc123" }),
    pushCurrentBranch: (_cwd, fallbackBranch) =>
      Effect.succeed({
        status: "pushed",
        branch: fallbackBranch ?? "feature/test",
        upstreamBranch: `origin/${fallbackBranch ?? "feature/test"}`,
        setUpstream: false,
      }),
    readRangeContext: () =>
      Effect.succeed({ commitSummary: "abc change", diffSummary: "1 file", diffPatch: "+change" }),
    readDefaultBranch: () => Effect.succeed(null),
    readConfigValue: () => Effect.succeed(null),
    listRemotes: () =>
      Effect.succeed([{ name: "origin", url: "https://github.com/t3tools/f5.git" }]),
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
    hasRemote: () => Effect.succeed(true),
    fetchRemoteBranchCommit: (input) =>
      Effect.succeed({
        remoteName: input.remoteName ?? "origin",
        branch: input.branch,
        refName: `${input.remoteName ?? "origin"}/${input.branch}`,
        commit: "0123456789abcdef0123456789abcdef01234567",
      }),
    fetchPullRequestBranch: () => Effect.void,
    ensureRemote: (input) => Effect.succeed(input.preferredName),
    fetchRemoteBranch: () => Effect.void,
    setBranchUpstream: () => Effect.void,
    removeWorktree: () => Effect.void,
    resolveCommonDir: (cwd) => Effect.succeed(`${cwd}/.git`),
    pruneWorktrees: () => Effect.void,
    resolveCommit: () => Effect.succeed("0123456789abcdef0123456789abcdef01234567"),
    readOperationInProgress: () => Effect.succeed(null),
    isAncestor: () => Effect.succeed(false),
    deleteBranchIfAt: () => Effect.succeed(true),
    readFileAtRevision: () => Effect.succeed(null),
    listIgnoredEntries: () => Effect.succeed({ entries: [], truncated: false }),
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
    readMoveSnapshot: (cwd) => {
      record("readMoveSnapshot", [cwd]);
      return implementations.readMoveSnapshot(cwd);
    },
    copyMoveUntracked: (source, target, files) => {
      record("copyMoveUntracked", [source, target, files]);
      return implementations.copyMoveUntracked(source, target, files);
    },
    stashCreate: (cwd) => {
      record("stashCreate", [cwd]);
      return implementations.stashCreate(cwd);
    },
    stashApplySha: (cwd, sha) => {
      record("stashApplySha", [cwd, sha]);
      return implementations.stashApplySha(cwd, sha);
    },
    stashPushAll: (cwd, message) => {
      record("stashPushAll", [cwd, message]);
      return implementations.stashPushAll(cwd, message);
    },
    setMoveRef: (cwd, ref, sha) => {
      record("setMoveRef", [cwd, ref, sha]);
      return implementations.setMoveRef(cwd, ref, sha);
    },
    deleteMoveRef: (cwd, ref, sha) => {
      record("deleteMoveRef", [cwd, ref, sha]);
      return implementations.deleteMoveRef(cwd, ref, sha);
    },
    cleanMoveCopies: (cwd, snapshot) => {
      record("cleanMoveCopies", [cwd, snapshot]);
      return implementations.cleanMoveCopies(cwd, snapshot);
    },

    isDirty: (cwd) => {
      record("isDirty", [cwd]);
      return implementations.isDirty(cwd);
    },
    cleanupSafetyProbe: (cwd) => {
      record("cleanupSafetyProbe", [cwd]);
      return implementations.cleanupSafetyProbe(cwd);
    },
    fastForwardTo: (cwd, sha) => {
      record("fastForwardTo", [cwd, sha]);
      return implementations.fastForwardTo(cwd, sha);
    },
    initializeWorktreeSubmodules: (path, policy) => {
      record("initializeWorktreeSubmodules", [path, policy]);
      return implementations.initializeWorktreeSubmodules(path, policy);
    },
    listWorktrees: (cwd) => {
      record("listWorktrees", [cwd]);
      return implementations.listWorktrees(cwd);
    },
    resolveCheckoutTarget: (input) => {
      record("resolveCheckoutTarget", [input]);
      return implementations.resolveCheckoutTarget(input);
    },
    inspectCheckoutIdentity: (path) => {
      record("inspectCheckoutIdentity", [path]);
      return implementations.inspectCheckoutIdentity(path);
    },
    inspectCheckout: (path, options) => {
      record("inspectCheckout", [path, options]);
      return implementations.inspectCheckout(path, options);
    },
    clearMissingRegistration: (cwd, path) => {
      record("clearMissingRegistration", [cwd, path]);
      return implementations.clearMissingRegistration(cwd, path);
    },
    readWorktreePreparation: (path) => {
      record("readWorktreePreparation", [path]);
      return implementations.readWorktreePreparation(path);
    },
    allocateWorktreePath: (input) => {
      record("allocateWorktreePath", [input]);
      return implementations.allocateWorktreePath(input);
    },
    resolveAvailableBranchName: (cwd, name) => {
      record("resolveAvailableBranchName", [cwd, name]);
      return implementations.resolveAvailableBranchName(cwd, name);
    },
    isValidBranchName: (name) => {
      record("isValidBranchName", [name]);
      return implementations.isValidBranchName(name);
    },
    cloneRepository: (input) => {
      record("cloneRepository", [input]);
      return implementations.cloneRepository(input);
    },
    branchExists: (cwd, branch) => {
      record("branchExists", [cwd, branch]);
      return implementations.branchExists(cwd, branch);
    },
    ensureWorktree: (input) => {
      record("ensureWorktree", [input]);
      return implementations.ensureWorktree(input);
    },
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
    commitPrepared: (cwd, subject, body, context, options) => {
      record("commitPrepared", [cwd, subject, body, context, options]);
      return implementations.commitPrepared(cwd, subject, body, context, options);
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
    readDefaultBranch: (cwd) => {
      record("readDefaultBranch", [cwd]);
      return implementations.readDefaultBranch(cwd);
    },
    readConfigValue: (cwd, key) => {
      record("readConfigValue", [cwd, key]);
      return implementations.readConfigValue(cwd, key);
    },
    listRemotes: (cwd) => {
      record("listRemotes", [cwd]);
      return implementations.listRemotes(cwd);
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
    hasRemote: (cwd) => {
      record("hasRemote", [cwd]);
      return implementations.hasRemote(cwd);
    },
    fetchRemoteBranchCommit: (input) => {
      record("fetchRemoteBranchCommit", [input]);
      return implementations.fetchRemoteBranchCommit(input);
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
    resolveCommonDir: (cwd) => {
      record("resolveCommonDir", [cwd]);
      return implementations.resolveCommonDir(cwd);
    },
    pruneWorktrees: (cwd) => {
      record("pruneWorktrees", [cwd]);
      return implementations.pruneWorktrees(cwd);
    },
    resolveCommit: (cwd, revision) => {
      record("resolveCommit", [cwd, revision]);
      return implementations.resolveCommit(cwd, revision);
    },
    readOperationInProgress: (cwd) => {
      record("readOperationInProgress", [cwd]);
      return implementations.readOperationInProgress(cwd);
    },
    isAncestor: (cwd, ancestor, descendant) => {
      record("isAncestor", [cwd, ancestor, descendant]);
      return implementations.isAncestor(cwd, ancestor, descendant);
    },
    deleteBranchIfAt: (input) => {
      record("deleteBranchIfAt", [input]);
      return implementations.deleteBranchIfAt(input);
    },
    readFileAtRevision: (input) => {
      record("readFileAtRevision", [input]);
      return implementations.readFileAtRevision(input);
    },
    listIgnoredEntries: (cwd) => {
      record("listIgnoredEntries", [cwd]);
      return implementations.listIgnoredEntries(cwd);
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
    request: () => Effect.die("Unexpected request"),
    getCredentialContext: () => Effect.die("Unexpected credentials"),
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
    changePullRequestReviewers: () => Effect.void,
    updatePullRequestBranch: () => Effect.void,
    updatePullRequestComment: () => Effect.void,
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

export const makeGitProjectRepositories = (
  projects: readonly ProjectionProject[] = [],
  listAll: () => Effect.Effect<
    readonly ProjectionProject[],
    import("../persistence/Errors").ProjectionRepositoryError
  > = () => Effect.succeed(projects),
) =>
  Layer.mergeAll(
    Layer.succeed(ProjectionProjectRepository, {
      listAll,
      getById: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      deleteById: () => Effect.void,
    }),
    Layer.succeed(ProjectionThreadRepository, {
      listByProjectId: () => Effect.succeed([]),
      listProjectIdsByWorktreePath: () => Effect.succeed([]),
      touchActivity: () => Effect.void,
      getActivityState: () => Effect.succeed(Option.none()),
      getById: () => Effect.succeed(Option.none()),
      upsert: () => Effect.void,
      deleteById: () => Effect.void,
    }),
  );

export const emptyGitProjectRepositories = makeGitProjectRepositories();
