import type { MoveSnapshotOperations } from "../moveSnapshot.ts";
import type { IgnoredFilesRemovalPolicy } from "../worktreeIgnoredFiles.ts";
/**
 * GitCore - Effect service contract for low-level Git operations.
 *
 * Wraps core repository primitives used by higher-level orchestration
 * services and WebSocket routes.
 *
 * @module GitCore
 */
import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";
import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullResult,
  GitStatusInput,
  GitStatusResult,
} from "@t3tools/contracts";

import type { WorktreeListEntry } from "../worktreeList.ts";

export interface RegisteredWorktree extends WorktreeListEntry {
  readonly canonicalPath: string;
}
export interface CheckoutIdentity {
  readonly canonicalRoot: string;
  readonly commonDir: string;
  readonly branch: string | null;
}
export interface CheckoutInspection extends CheckoutIdentity {
  /** Local status/index/file-metadata identity for recovery acceptance, without a diff-stat scan. */
  readonly localFingerprint?: string;
  readonly canonicalRoot: string;
  readonly commonDir: string;
  readonly registration: RegisteredWorktree | null;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly operation: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | null;
  readonly hasInitializedSubmodules: boolean;
  readonly hasTrackedChanges: boolean;
  readonly hasUntrackedChanges: boolean;
  /**
   * Repo-relative paths from `git status`. Untracked directories end in `/`,
   * except with `changesFingerprint`, which lists every untracked file.
   */
  readonly changedPaths?: ReadonlyArray<string>;
  /** The untracked subset of `changedPaths`. */
  readonly untrackedPaths?: ReadonlyArray<string>;
  /** Status, index and file metadata of `changedPaths`, when requested with `changesFingerprint`. */
  readonly changesFingerprint?: string;
  readonly ignoredEntries: ReadonlyArray<string>;
  readonly ignoredTruncated: boolean;
  readonly upstreamRef: string | null;
  readonly upstreamSha: string | null;
  readonly aheadCount: number | null;
  readonly behindCount: number | null;
}

/** Internal compatibility input; force is never honored for an existing checkout. */
export interface InternalRemoveWorktreeInput {
  readonly cwd: string;
  readonly path: string;
  readonly force?: boolean;
  /** Explicit ignored-file policy; omitted by automated callers to protect local files. */
  readonly ignoredFiles?: IgnoredFilesRemovalPolicy;
  /** Storage cleanup only: the caller verified that the detached HEAD is merged. */
  readonly allowDetachedHead?: boolean;
  /**
   * Storage cleanup only: discard exactly these reviewed changes. Removal is
   * refused unless the current changed paths and their fingerprint still match.
   */
  readonly discardChanges?: {
    readonly paths: ReadonlyArray<string>;
    readonly fingerprint: string;
  };
}

import type { GitCommandError } from "../Errors.ts";

export interface GitStatusDetails extends Omit<GitStatusResult, "pr" | "changeRequest"> {
  upstreamRef: string | null;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  preserveExisting?: boolean;
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  /** Never replace an existing branch, including one created after the caller checked. */
  preserveExisting?: boolean;
  /** Native forge request head ref; defaults to refs/heads/<remoteBranch>. */
  remoteRef?: string;
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteBranchCommitInput {
  /** Return null only when the selected branch is absent from the remote. */
  allowMissingBranch?: boolean;
  cwd: string;
  branch: string;
  remoteName?: string;
}

export interface GitRemoteBranchCommit {
  remoteName: string;
  branch: string;
  refName: string;
  commit: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemote {
  readonly name: string;
  readonly url: string | null;
}

/** Synchronous progress callbacks; they run on git's output stream and must not block. */
export interface GitWorktreeProgress {
  /** Git has registered the directory, so a cancel from here on must remove it. */
  readonly onWorktreeClaimed?: (path: string) => void;
  readonly onCheckoutProgress?: (progress: {
    readonly percent: number;
    readonly completed: number;
    readonly total: number;
  }) => void;
  readonly onSubmodulesStarted?: () => void;
  readonly onSubmoduleLine?: (line: string) => void;
  readonly onSubmodulesFinished?: (result: {
    readonly status: "done" | "skipped" | "warning";
    readonly detail: string | null;
  }) => void;
}

/**
 * GitCoreShape - Service API for low-level Git repository interactions.
 */
export interface GitCoreShape extends MoveSnapshotOperations {
  /** Await refreshes admitted for an owned checkout before releasing its files. */
  readonly drainUpstreamRefreshes?: (cwd: string) => Effect.Effect<void>;

  /** Fires only after an actual successful upstream refresh, never on a cache hit. */
  readonly subscribeStatusRefresh?: (listener: (cwd: string) => void) => Effect.Effect<() => void>;

  /** Local, bounded inventory status. Unknown/unreadable returns null. */
  readonly isDirty: (cwd: string) => Effect.Effect<boolean | null>;
  readonly listWorktrees: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<RegisteredWorktree>, GitCommandError>;
  /** Identity only: no status scan, upstream refresh, or repository mutation lock. */
  readonly inspectCheckoutIdentity: (
    path: string,
  ) => Effect.Effect<CheckoutIdentity, GitCommandError>;
  readonly inspectCheckout: (
    path: string,
    options?: {
      aheadOf?: string;
      statusTimeoutMs?: number;
      recoveryFingerprint?: boolean;
      /** Fingerprint the changes and list untracked files individually, for exact discard. */
      changesFingerprint?: boolean;
    },
  ) => Effect.Effect<CheckoutInspection, GitCommandError>;
  readonly clearMissingRegistration: (
    cwd: string,
    path: string,
  ) => Effect.Effect<void, GitCommandError>;
  /**
   * Read Git status for a repository.
   */
  readonly status: (input: GitStatusInput) => Effect.Effect<GitStatusResult, GitCommandError>;

  /** Recreate a missing linked worktree from its existing branch under lifecycle locks. */
  readonly ensureWorktree: (input: {
    submodules?: import("@t3tools/contracts").WorktreeSubmodules;
    owner?: string;
    cwd: string;
    path: string;
    branch: string;
  }) => Effect.Effect<{ recreated: boolean }, GitCommandError>;
  readonly fastForwardTo: (cwd: string, sha: string) => Effect.Effect<void, GitCommandError>;
  readonly initializeWorktreeSubmodules: (
    path: string,
    policy: import("@t3tools/contracts").WorktreeSubmodules,
  ) => Effect.Effect<void, GitCommandError>;
  readonly branchExists: (cwd: string, branch: string) => Effect.Effect<boolean, GitCommandError>;
  /** Read detailed status without the polling cache, for mutation decisions. */
  /** `refreshUpstream: false` skips the stale-upstream fetch, for callers that only read local state. */
  readonly statusDetails: (
    cwd: string,
    options?: { readonly refreshUpstream?: boolean },
  ) => Effect.Effect<GitStatusDetails, GitCommandError>;
  /** Uncached removal check; repository config cannot hide untracked or ignored files. */
  readonly cleanupSafetyProbe: (
    cwd: string,
  ) => Effect.Effect<import("../cleanupSafety.ts").CleanupSafetyProbe, GitCommandError>;

  /**
   * Build commit-generation context in a temporary index; never stage the real index.
   */
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;

  /** Revalidate a prepared context under the repository lock, then stage and commit. */
  readonly commitPrepared: (
    cwd: string,
    subject: string,
    body: string,
    context: GitPreparedCommitContext,
    options?: { newBranch?: string },
  ) => Effect.Effect<
    { status: "created"; commitSha: string } | { status: "context_changed" },
    GitCommandError
  >;

  /**
   * Create a commit with provided subject/body.
   */
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;

  /**
   * Push current branch, setting upstream if needed.
   */
  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
  ) => Effect.Effect<GitPushResult, GitCommandError>;

  /**
   * Collect commit/diff context between base branch and current HEAD.
   */
  readonly readRangeContext: (
    cwd: string,
    baseBranch: string,
  ) => Effect.Effect<GitRangeContext, GitCommandError>;

  /**
   * Read a Git config value from the local repository.
   */
  readonly readDefaultBranch: (cwd: string) => Effect.Effect<string | null, GitCommandError>;

  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;

  /** List every configured remote in Git's stable order, including its fetch URL. */
  readonly listRemotes: (cwd: string) => Effect.Effect<ReadonlyArray<GitRemote>, GitCommandError>;

  /**
   * List local + remote branches and branch metadata.
   */
  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitCommandError>;

  /**
   * Pull current branch from upstream using fast-forward only.
   */
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<GitPullResult, GitCommandError>;

  /**
   * Create a worktree and branch from a base branch.
   */
  readonly readWorktreePreparation: (
    path: string,
  ) => Effect.Effect<
    import("../../persistence/Services/WorktreePreparations.ts").WorktreePreparationReceipt | null,
    GitCommandError
  >;
  readonly allocateWorktreePath: (input: {
    cwd: string;
    branch: string;
  }) => Effect.Effect<string, GitCommandError>;
  readonly isValidBranchName: (name: string) => Effect.Effect<boolean, GitCommandError>;
  readonly resolveAvailableBranchName: (
    cwd: string,
    name: string,
  ) => Effect.Effect<string, GitCommandError>;
  readonly createWorktree: (
    input: GitCreateWorktreeInput & {
      submodules?: import("@t3tools/contracts").WorktreeSubmodules;
      preparation?: {
        owner: string;
        projectCwd?: string;
        requestedBase?: string;
        replaceMissing?: boolean;
        operationId?: string;
        namingIntent?: "explicit" | "generated" | "temporary" | "existing";
        runSetupScript?: boolean;
        setupIdentity?: string | null;
      };
      /** Live checkout and submodule progress, for the worktree setup card. */
      progress?: GitWorktreeProgress;
    },
  ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;

  /** Resolve the absolute git-common-dir shared by every worktree of a repository. */
  readonly resolveCommonDir: (cwd: string) => Effect.Effect<string, GitCommandError>;

  /** `git worktree prune` under the cross-profile repository lock. */
  readonly pruneWorktrees: (cwd: string) => Effect.Effect<void, GitCommandError>;

  /** Resolve a revision to a commit SHA, or null when it does not name a commit. */
  readonly resolveCommit: (
    cwd: string,
    revision: string,
  ) => Effect.Effect<string | null, GitCommandError>;

  /** A merge, rebase, cherry-pick, revert or bisect in progress in this checkout, or null. */
  readonly readOperationInProgress: (
    cwd: string,
  ) => Effect.Effect<
    "merge" | "rebase" | "cherry-pick" | "revert" | "bisect" | null,
    GitCommandError
  >;

  /** `merge-base --is-ancestor`: true when `ancestor` is reachable from `descendant`. */
  readonly isAncestor: (
    cwd: string,
    ancestor: string,
    descendant: string,
  ) => Effect.Effect<boolean, GitCommandError>;

  /**
   * Deletes `refs/heads/<branch>` only while it still points at `expectedSha`
   * (an atomic compare-and-delete). Returns false when the branch moved.
   */
  readonly deleteBranchIfAt: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly expectedSha: string;
    /** Check all registered worktrees while holding the repository lifecycle lock. */
    readonly onlyIfUnused?: boolean;
  }) => Effect.Effect<boolean, GitCommandError>;

  /** Reads a small file from a revision without checking it out. Null when absent. */
  readonly readFileAtRevision: (input: {
    readonly cwd: string;
    readonly revision: string;
    readonly path: string;
    readonly maxBytes: number;
  }) => Effect.Effect<string | null, GitCommandError>;

  /** Ignored untracked entries (directories collapsed), bounded. */
  readonly listIgnoredEntries: (
    cwd: string,
  ) => Effect.Effect<
    { readonly entries: ReadonlyArray<string>; readonly truncated: boolean },
    GitCommandError
  >;

  /**
   * Report whether the repository has at least one configured remote.
   */
  readonly hasRemote: (cwd: string) => Effect.Effect<boolean, GitCommandError>;

  /**
   * Fetch a remote-tracking branch and resolve its commit without mutating local branches.
   */
  readonly fetchRemoteBranchCommit: (
    input: GitFetchRemoteBranchCommitInput,
  ) => Effect.Effect<GitRemoteBranchCommit | null, GitCommandError>;

  /**
   * Materialize a GitHub pull request head as a local branch without switching checkout.
   */
  readonly fetchPullRequestBranch: (
    input: GitFetchPullRequestBranchInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Ensure a named remote exists for the provided URL, returning the reused or created remote name.
   */
  readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;

  /**
   * Fetch a remote branch into a local branch without checkout.
   */
  readonly fetchRemoteBranch: (
    input: GitFetchRemoteBranchInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Set the upstream tracking branch for a local branch.
   */
  readonly setBranchUpstream: (
    input: GitSetBranchUpstreamInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Remove an existing worktree.
   */
  readonly removeWorktree: (
    input: InternalRemoveWorktreeInput,
  ) => Effect.Effect<void, GitCommandError>;

  /**
   * Rename an existing local branch.
   */
  readonly renameBranch: (
    input: GitRenameBranchInput,
  ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;

  /**
   * Create a local branch.
   */
  readonly createBranch: (input: GitCreateBranchInput) => Effect.Effect<void, GitCommandError>;

  /**
   * Checkout an existing branch and refresh its upstream metadata in background.
   */
  readonly resolveCheckoutTarget: (
    input: GitCheckoutInput,
  ) => Effect.Effect<
    { branch: string | null; headSha: string | null; checkoutArgs: ReadonlyArray<string> },
    GitCommandError
  >;
  readonly checkoutBranch: (
    input: GitCheckoutInput,
    options?: { refreshUpstream?: boolean; expectedTarget?: { branch: string; headSha: string } },
  ) => Effect.Effect<void, GitCommandError, Scope.Scope>;

  /**
   * Initialize a repository in the provided directory.
   */
  readonly cloneRepository: (input: {
    cwd: string;
    url: string;
    onProgress: (chunk: Uint8Array) => void;
  }) => Effect.Effect<void, GitCommandError>;
  readonly initRepo: (input: GitInitInput) => Effect.Effect<void, GitCommandError>;

  /**
   * List local branch names (short format).
   */
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
}

/**
 * GitCore - Service tag for low-level Git repository operations.
 */
export class GitCore extends ServiceMap.Service<GitCore, GitCoreShape>()(
  "t3/git/Services/GitCore",
) {}
