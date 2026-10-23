import { isPrHubRepositoryExcluded } from "../../prHub/repositoryPolicy.ts";
import { GitHubRequestPolicy } from "../githubRequestPolicy.ts";
import { lookupBranchPullRequest } from "../branchPullRequestLookup.ts";
import { GitWorkspaceSwitch } from "../workspaceSwitch.ts";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import { readProjectSettings, readProjectForCwd } from "../../project/projectSettings";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads";
import { GitCommandError, GitHubCliError } from "../Errors.ts";
import {
  isSshRemoteUrl,
  parseSourceControlRemoteUrl,
  parseGitHubPullRequestUrl,
} from "@t3tools/shared/sourceControl";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";

import { Effect, FileSystem, Layer, Path, Option, PubSub, Schema, Stream } from "effect";
import {
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";
import {
  type ServerSettings,
  type ChangeRequest,
  type SourceControlProviderIdentity,
} from "@t3tools/contracts";

import { GitManagerError } from "../Errors.ts";
import { isPullRequestTrackingAlias, extractBranchNameFromRemoteRef } from "../remoteRefs.ts";
import { GitManager, type GitManagerShape } from "../Services/GitManager.ts";
import { GitCore, type GitPreparedCommitContext } from "../Services/GitCore.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { makeGitHubCli } from "./GitHubCli.ts";
import { GitHubCredentialScope } from "../githubApi.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildDeterministicCommitMessage,
  buildDeterministicPrContent,
  prefixGeneratedBranchName,
} from "../Prompts.ts";
import { ForgeAccounts } from "../../sourceControl/accountRouting.ts";
import { makeForgeSourceControlProvider } from "../../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../../sourceControl/SourceControlProvider.ts";
import { makeGitHubSourceControlProvider } from "../../sourceControl/GitHubSourceControlProvider.ts";
import {
  makeSourceControlProviderRegistry,
  type SourceControlProvider,
} from "../../sourceControl/SourceControlProvider.ts";
import {
  discoverSourceControlProviderIdentities,
  selectPrimarySourceControlProviderIdentity,
} from "../../sourceControl/discovery.ts";

interface OpenPrInfo {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

interface PullRequestInfo extends OpenPrInfo, PullRequestHeadRemoteInfo {
  headRefOid?: string | null;
  state: "open" | "closed" | "merged";
  updatedAt: string | null;
}

interface ResolvedPullRequest {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  headOid?: string | null;
  state: "open" | "closed" | "merged";
}

interface PullRequestHeadRemoteInfo {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}

interface BranchHeadContext {
  localBranch: string;
  headBranch: string;
  headSelectors: ReadonlyArray<string>;
  preferredHeadSelector: string;
  remoteName: string | null;
  headRepositoryNameWithOwner: string | null;
  headRepositoryOwnerLogin: string | null;
  isCrossRepository: boolean;
}

function parseRepositoryNameFromPullRequestUrl(url: string): string | null {
  return parseGitHubPullRequestUrl(url)?.repository.split("/")[1] ?? null;
}

function resolveHeadRepositoryNameWithOwner(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string | null {
  const explicitRepository = pullRequest.headRepositoryNameWithOwner?.trim() ?? "";
  if (explicitRepository.length > 0) {
    return explicitRepository;
  }

  if (!pullRequest.isCrossRepository) {
    return null;
  }

  const ownerLogin = pullRequest.headRepositoryOwnerLogin?.trim() ?? "";
  const repositoryName = parseRepositoryNameFromPullRequestUrl(pullRequest.url);
  if (ownerLogin.length === 0 || !repositoryName) {
    return null;
  }

  return `${ownerLogin}/${repositoryName}`;
}

function resolvePullRequestWorktreeLocalBranchName(
  pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
): string {
  if (!pullRequest.isCrossRepository) {
    return pullRequest.headBranch;
  }

  const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
  const suffix = sanitizedHeadBranch.length > 0 ? sanitizedHeadBranch : "head";
  return `t3code/pr-${pullRequest.number}/${suffix}`;
}

function parseGitHubRepositoryNameWithOwnerFromRemoteUrl(url: string | null): string | null {
  const remote = parseSourceControlRemoteUrl(url);
  return remote.kind === "github" && remote.owner && remote.repository
    ? `${remote.owner}/${remote.repository}`
    : null;
}

function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

function gitManagerError(operation: string, detail: string, cause?: unknown): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

interface CommitAndBranchSuggestion {
  context: GitPreparedCommitContext;
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

function appendUnique(values: string[], next: string | null | undefined): void {
  const trimmed = next?.trim() ?? "";
  if (trimmed.length === 0 || values.includes(trimmed)) {
    return;
  }
  values.push(trimmed);
}

function toStatusPr(pr: PullRequestInfo): {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  headOid?: string;
  state: "open" | "closed" | "merged";
} {
  const headOid = pr.headRefOid?.trim();
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    ...(headOid ? { headOid } : {}),
    state: pr.state,
  };
}

function toChangeRequest(
  pr: PullRequestInfo | ResolvedPullRequest,
  provider: SourceControlProviderIdentity,
): ChangeRequest {
  const baseRefName = "baseRefName" in pr ? pr.baseRefName : pr.baseBranch;
  const headRefName = "headRefName" in pr ? pr.headRefName : pr.headBranch;
  const headRepository =
    "headRepositoryNameWithOwner" in pr && pr.headRepositoryNameWithOwner?.trim()
      ? pr.headRepositoryNameWithOwner.trim()
      : null;
  const baseRepository =
    provider.owner && provider.repository ? `${provider.owner}/${provider.repository}` : null;
  const isCrossRepository =
    ("isCrossRepository" in pr && pr.isCrossRepository === true) ||
    (headRepository !== null &&
      baseRepository !== null &&
      headRepository.toLowerCase() !== baseRepository.toLowerCase());
  return {
    provider,
    id: String(pr.number),
    displayNumber: String(pr.number),
    title: pr.title,
    url: pr.url,
    baseRefName,
    headRefName,
    state: pr.state ?? "open",
    updatedAt: "updatedAt" in pr ? pr.updatedAt : null,
    isCrossRepository,
    ...(headRepository ? { headRepository } : {}),
    ...(baseRepository ? { baseRepository } : {}),
  };
}

function normalizePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  const hashNumber = /^#(\d+)$/.exec(trimmed);
  return hashNumber?.[1] ?? trimmed;
}

function canonicalizeExistingPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return value;
  }
}

function toResolvedPullRequest(pr: {
  number: number;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string | null;
  state?: "open" | "closed" | "merged";
}): ResolvedPullRequest {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    ...(pr.headRefOid !== undefined ? { headOid: pr.headRefOid } : {}),
    state: pr.state ?? "open",
  };
}

function matchesBranchHeadContext(
  pr: { headRefName: string } & PullRequestHeadRemoteInfo,
  context: BranchHeadContext,
): boolean {
  if (pr.headRefName !== context.headBranch) return false;
  const expectedRepo = context.headRepositoryNameWithOwner?.toLowerCase();
  const actualRepo = pr.headRepositoryNameWithOwner?.toLowerCase();
  const expectedOwner =
    context.headRepositoryOwnerLogin?.toLowerCase() ?? expectedRepo?.split("/")[0];
  const actualOwner = pr.headRepositoryOwnerLogin?.toLowerCase() ?? actualRepo?.split("/")[0];
  if (expectedRepo && actualRepo && expectedRepo !== actualRepo) return false;
  if (expectedOwner && actualOwner && expectedOwner !== actualOwner) return false;
  if (context.isCrossRepository) {
    if (pr.isCrossRepository === false) return false;
    if ((expectedRepo || expectedOwner) && !actualRepo && !actualOwner) return false;
  } else if (
    pr.isCrossRepository &&
    (!(expectedRepo || expectedOwner) || !(actualRepo || actualOwner))
  ) {
    return false;
  }
  return true;
}

function shouldPreferSshRemote(url: string | null): boolean {
  if (!url) return false;
  return isSshRemoteUrl(url);
}

function toPullRequestHeadRemoteInfo(pr: {
  isCrossRepository?: boolean;
  headRepositoryNameWithOwner?: string | null;
  headRepositoryOwnerLogin?: string | null;
}): PullRequestHeadRemoteInfo {
  return {
    ...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
    ...(pr.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: pr.headRepositoryNameWithOwner }
      : {}),
    ...(pr.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: pr.headRepositoryOwnerLogin }
      : {}),
  };
}

export const makeGitManager = Effect.gen(function* () {
  // The last PR state each status read saw. Thread details show this read, so a merge it sees
  // must reach settlement right away instead of waiting for the next sweep.
  const pullRequestStateChanges = yield* PubSub.sliding<string>(64);
  const statusPullRequestStates = new Map<string, PullRequestInfo["state"]>();
  const noteStatusPullRequestState = (pr: PullRequestInfo) =>
    Effect.suspend(() => {
      // An unseen PR counts as open, so only a terminal first read announces.
      const previous = statusPullRequestStates.get(pr.url) ?? "open";
      statusPullRequestStates.delete(pr.url);
      if (statusPullRequestStates.size >= 256) {
        const oldest = statusPullRequestStates.keys().next().value;
        if (oldest !== undefined) statusPullRequestStates.delete(oldest);
      }
      statusPullRequestStates.set(pr.url, pr.state);
      return previous === pr.state
        ? Effect.void
        : PubSub.publish(pullRequestStateChanges, pr.url).pipe(Effect.asVoid);
    });
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const forgeAccounts = yield* Effect.serviceOption(ForgeAccounts);
  const resolveGitHubAccount = (cwd: string) =>
    Effect.gen(function* () {
      if (Option.isNone(forgeAccounts))
        return yield* new SourceControlProviderError({
          provider: "github",
          operation: "account.resolve",
          kind: "unauthenticated",
          detail: "Configure a forge account before using this repository.",
        });
      const identity = yield* resolveSourceControlProviderIdentity(cwd);
      if (identity.kind !== "github" || !identity.host || !identity.owner || !identity.repository)
        return yield* new SourceControlProviderError({
          provider: "github",
          operation: "account.resolve",
          kind: "forbidden",
          detail: "The repository does not identify a configured GitHub account.",
        });
      return yield* forgeAccounts.value.resolveAccount({
        cwd,
        ref: {
          provider: "github",
          host: identity.host,
          repository: `${identity.owner}/${identity.repository}`,
          number: 1,
        },
      });
    });
  const routedGitHub = Option.isSome(forgeAccounts)
    ? yield* makeGitHubCli({
        resolveToken: (host, cwd) =>
          resolveGitHubAccount(cwd).pipe(
            Effect.flatMap((account) =>
              account.host.toLowerCase() === host.toLowerCase()
                ? Effect.succeed(account.token)
                : Effect.fail(
                    new SourceControlProviderError({
                      provider: "github",
                      operation: "account.resolve",
                      kind: "forbidden",
                      detail: "GitHub account host does not match the repository.",
                    }),
                  ),
            ),
            Effect.mapError(
              (error) =>
                new GitHubCliError({
                  operation: "account.resolve",
                  kind: "forbidden",
                  detail: error.detail,
                  requestDispatched: false,
                }),
            ),
          ),
      })
    : gitHubCli;
  const baseGitHubProvider = makeGitHubSourceControlProvider(routedGitHub);
  const legacyGitHubProvider = makeGitHubSourceControlProvider(gitHubCli);
  const scopedGitHubProvider = Option.isSome(forgeAccounts)
    ? (Object.fromEntries(
        Object.entries(baseGitHubProvider).map(([name, value]) => {
          if (typeof value !== "function" || name === "capability" || name === "requireCapability")
            return [name, value];
          const call = value as (input: {
            cwd: string;
          }) => Effect.Effect<unknown, SourceControlProviderError>;
          return [
            name,
            (input: { cwd: string }) =>
              Effect.gen(function* () {
                const identity = yield* resolveSourceControlProviderIdentity(input.cwd);
                const accounts = Option.isSome(forgeAccounts)
                  ? yield* forgeAccounts.value.listAccounts()
                  : [];
                if (
                  !accounts.some(
                    (account) =>
                      account.provider === "github" &&
                      account.host.toLowerCase() === identity.host?.toLowerCase(),
                  )
                ) {
                  const legacyCall = legacyGitHubProvider[
                    name as keyof SourceControlProvider
                  ] as typeof call;
                  return yield* legacyCall(input);
                }
                const account = yield* resolveGitHubAccount(input.cwd);
                const context = yield* routedGitHub
                  .getCredentialContext({ cwd: input.cwd, host: account.host })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new SourceControlProviderError({
                          provider: "github",
                          operation: "account.resolve",
                          kind: "forbidden",
                          detail: error.detail,
                          requestDispatched: false,
                        }),
                    ),
                  );
                if (
                  String(context.viewerId) !== account.viewerId ||
                  context.login !== account.login
                )
                  return yield* new SourceControlProviderError({
                    provider: "github",
                    operation: "account.resolve",
                    kind: "forbidden",
                    detail: "GitHub credentials do not match the routed account.",
                    requestDispatched: false,
                  });
                return yield* call(input).pipe(
                  Effect.provideService(GitHubCredentialScope, context),
                );
              }),
          ];
        }),
      ) as SourceControlProvider)
    : baseGitHubProvider;
  const sourceControlProviders = makeSourceControlProviderRegistry([
    scopedGitHubProvider,
    ...(["gitlab", "bitbucket", "azure-devops", "forgejo"] as const).map((kind) =>
      makeForgeSourceControlProvider({
        kind,
        resolveAccount: (input) =>
          Effect.gen(function* () {
            if (Option.isNone(forgeAccounts))
              return yield* new SourceControlProviderError({
                provider: kind,
                operation: "account.resolve",
                detail: "Configure a forge account before using this repository.",
                kind: "unauthenticated",
              });
            let ref = input.ref;
            if (!ref && input.cwd) {
              const identity = yield* resolveSourceControlProviderIdentity(input.cwd);
              if (
                identity.kind !== kind ||
                !identity.host ||
                !identity.owner ||
                !identity.repository
              )
                return yield* new SourceControlProviderError({
                  provider: kind,
                  operation: "account.resolve",
                  detail: "Repository does not match the selected forge.",
                  kind: "unsupported",
                });
              ref = {
                provider: kind,
                host: identity.host,
                repository: `${identity.owner}/${identity.repository}`,
                number: 1,
              };
            }
            const resolved = yield* forgeAccounts.value.resolveAccount({
              ...(ref ? { ref } : {}),
              ...(input.cwd ? { cwd: input.cwd } : {}),
            });
            if (resolved.kind !== kind)
              return yield* new SourceControlProviderError({
                provider: kind,
                operation: "account.resolve",
                detail: "Account does not match selected forge.",
                kind: "forbidden",
              });
            return {
              ...resolved,
              kind,
              login: kind === "azure-devops" ? resolved.viewerId : resolved.login,
            };
          }),
      }),
    ),
  ]);
  const githubProvider = yield* sourceControlProviders.get("github");
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;

  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  const getProject = (cwd: string) =>
    readProjectForCwd(cwd).pipe(
      Effect.provideService(ProjectionProjectRepository, projects),
      Effect.provideService(ProjectionThreadRepository, threads),
      Effect.mapError((cause) => gitManagerError("projectSettings", cause.message)),
    );
  const getProjectSettings = (cwd: string) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const project = yield* getProject(cwd);
      return project
        ? (yield* readProjectSettings(settings, { ...project, id: project.projectId })).settings
        : settings;
    }).pipe(Effect.mapError((cause) => gitManagerError("projectSettings", cause.message)));

  const configurePullRequestHeadUpstream = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    provider: SourceControlProvider,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      if (repositoryNameWithOwner.length === 0) {
        return;
      }

      const cloneUrls = yield* provider.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.setBranchUpstream({
        cwd,
        branch: localBranch,
        remoteName,
        remoteBranch: pullRequest.headBranch,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `GitManager.configurePullRequestHeadUpstream: failed to configure upstream for ${localBranch} -> ${pullRequest.headBranch} in ${cwd}: ${error.message}`,
        ).pipe(Effect.asVoid),
      ),
    );

  const materializePullRequestHeadBranch = (
    cwd: string,
    pullRequest: ResolvedPullRequest & PullRequestHeadRemoteInfo,
    provider: SourceControlProvider,
    localBranch = pullRequest.headBranch,
  ) =>
    Effect.gen(function* () {
      const repositoryNameWithOwner = resolveHeadRepositoryNameWithOwner(pullRequest) ?? "";
      {
        if ((yield* gitCore.listLocalBranchNames(cwd)).includes(localBranch)) {
          const existing = yield* gitCore.resolveCommit(cwd, localBranch);
          if (pullRequest.headOid && existing !== pullRequest.headOid)
            return yield* gitManagerError(
              "preparePullRequestThread",
              `Local branch '${localBranch}' contains a different commit; select a fresh worktree branch to preserve it.`,
            );
          return;
        }
      }
      if (provider.kind !== "github") {
        const identity = yield* resolveSourceControlProviderIdentity(cwd);
        let remoteName = identity.remoteName ?? "origin";
        if (pullRequest.isCrossRepository && !repositoryNameWithOwner)
          return yield* gitManagerError(
            "preparePullRequestThread",
            "The fork repository identity is unavailable; refusing to configure a push target.",
          );
        if (pullRequest.isCrossRepository && repositoryNameWithOwner) {
          const cloneUrls = yield* provider.getRepositoryCloneUrls({
            cwd,
            repository: repositoryNameWithOwner,
          });
          const origin = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
          remoteName = yield* gitCore.ensureRemote({
            cwd,
            preferredName: pullRequest.headRepositoryOwnerLogin ?? "fork",
            url: shouldPreferSshRemote(origin) ? cloneUrls.sshUrl : cloneUrls.url,
          });
        }
        const remoteBranch = pullRequest.headBranch;
        yield* gitCore.fetchRemoteBranch({
          cwd,
          remoteName,
          remoteBranch,
          localBranch,
          preserveExisting: true,
          ...(!pullRequest.isCrossRepository && provider.kind === "gitlab"
            ? { remoteRef: `refs/merge-requests/${pullRequest.number}/head` }
            : !pullRequest.isCrossRepository && provider.kind === "forgejo"
              ? { remoteRef: `refs/pull/${pullRequest.number}/head` }
              : {}),
        });
        return;
      }

      if (repositoryNameWithOwner.length === 0) {
        yield* gitCore.fetchPullRequestBranch({
          cwd,
          prNumber: pullRequest.number,
          branch: localBranch,
          preserveExisting: true,
        });
        return;
      }

      const cloneUrls = yield* provider.getRepositoryCloneUrls({
        cwd,
        repository: repositoryNameWithOwner,
      });
      const originRemoteUrl = yield* gitCore.readConfigValue(cwd, "remote.origin.url");
      const remoteUrl = shouldPreferSshRemote(originRemoteUrl) ? cloneUrls.sshUrl : cloneUrls.url;
      const preferredRemoteName =
        pullRequest.headRepositoryOwnerLogin?.trim() ||
        repositoryNameWithOwner.split("/")[0]?.trim() ||
        "fork";
      const remoteName = yield* gitCore.ensureRemote({
        cwd,
        preferredName: preferredRemoteName,
        url: remoteUrl,
      });

      yield* gitCore.fetchRemoteBranch({
        cwd,
        remoteName,
        remoteBranch: pullRequest.headBranch,
        localBranch,
        preserveExisting: true,
      });
    }).pipe(
      Effect.catch((cause) =>
        provider.kind !== "github" || Schema.is(GitManagerError)(cause)
          ? Effect.fail(cause)
          : gitCore.fetchPullRequestBranch({
              cwd,
              prNumber: pullRequest.number,
              branch: localBranch,
              preserveExisting: true,
            }),
      ),
    );
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const readConfigValueNullable = (cwd: string, key: string) =>
    gitCore.readConfigValue(cwd, key).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveSourceControlProviderIdentity = (cwd: string) =>
    Effect.gen(function* () {
      const discoveredRemotes = yield* gitCore
        .listRemotes(cwd)
        .pipe(Effect.catch(() => Effect.succeed([])));
      const remotes =
        discoveredRemotes.length > 0
          ? discoveredRemotes
          : yield* readConfigValueNullable(cwd, "remote.origin.url").pipe(
              Effect.map((url) => (url ? [{ name: "origin", url }] : [])),
            );
      const accounts = Option.isSome(forgeAccounts)
        ? yield* forgeAccounts.value.listAccounts().pipe(Effect.catch(() => Effect.succeed([])))
        : [];
      return selectPrimarySourceControlProviderIdentity(
        discoverSourceControlProviderIdentities(remotes, {
          githubHosts: [
            ...(process.env.GH_HOST ? [process.env.GH_HOST] : []),
            ...accounts.filter((a) => a.provider === "github").map((a) => a.host),
          ],
          providerHosts: accounts.map((a) => ({ kind: a.provider, host: a.host })),
        }),
        {
          availableProviderKinds: sourceControlProviders.providers.map((provider) => provider.kind),
        },
      );
    });

  // Preserve the historical GitHub CLI fallback when Git cannot identify the
  // remote host (for example, a local-path remote). Positively identified
  // non-GitHub providers still fail closed until their adapters exist.
  const sourceControlProviderForIdentity = (identity: SourceControlProviderIdentity) =>
    identity.kind === "unknown"
      ? Effect.succeed(githubProvider)
      : sourceControlProviders.getForIdentity(identity);

  const resolveRemoteRepositoryContext = (cwd: string, remoteName: string | null) =>
    Effect.gen(function* () {
      if (!remoteName) {
        return {
          repositoryNameWithOwner: null,
          ownerLogin: null,
        };
      }

      const remoteUrl = yield* readConfigValueNullable(cwd, `remote.${remoteName}.url`);
      const repositoryNameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
      return {
        repositoryNameWithOwner,
        ownerLogin: parseRepositoryOwnerLogin(repositoryNameWithOwner),
      };
    });

  // A branch pushed without `-u` (often to a fork) names no remote. Prefer the
  // one remote whose tip is exactly the branch, then the one whose tip is in its
  // history (local commits after the last push); never break a tie by remote
  // order, and let a failed probe reject the inference.
  const findPublishedBranchRemote = (cwd: string, branch: string) =>
    Effect.gen(function* () {
      const localOid = yield* gitCore.resolveCommit(cwd, `refs/heads/${branch}`);
      if (localOid === null) return null;
      const remotes = yield* gitCore.listRemotes(cwd);
      const tips = (yield* Effect.forEach(
        remotes.filter((remote) => remote.url !== null),
        (remote) =>
          gitCore
            .resolveCommit(cwd, `refs/remotes/${remote.name}/${branch}`)
            .pipe(Effect.map((oid) => (oid === null ? [] : [{ name: remote.name, oid }]))),
        { concurrency: "unbounded" },
      )).flat();
      const exact = tips.filter((tip) => tip.oid === localOid);
      if (exact.length > 0) return exact.length === 1 ? exact[0]!.name : null;
      const ancestors = yield* Effect.filter(
        tips,
        (tip) => gitCore.isAncestor(cwd, tip.oid, localOid),
        { concurrency: "unbounded" },
      );
      return ancestors.length === 1 ? ancestors[0]!.name : null;
    });

  const resolveBranchHeadContext = (
    cwd: string,
    details: { branch: string; upstreamRef: string | null; remoteName?: string },
  ) =>
    Effect.gen(function* () {
      const remoteName =
        details.remoteName ??
        (yield* readConfigValueNullable(cwd, `branch.${details.branch}.remote`)) ??
        (details.upstreamRef === null
          ? yield* findPublishedBranchRemote(cwd, details.branch).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null);
      const headBranchFromUpstream = details.upstreamRef
        ? extractBranchNameFromRemoteRef(details.upstreamRef, { remoteName })
        : "";

      const [remoteRepository, originRepository] = yield* Effect.all(
        [
          resolveRemoteRepositoryContext(cwd, remoteName),
          resolveRemoteRepositoryContext(cwd, "origin"),
        ],
        { concurrency: "unbounded" },
      );

      const isCrossRepository =
        remoteRepository.repositoryNameWithOwner !== null &&
        originRepository.repositoryNameWithOwner !== null
          ? remoteRepository.repositoryNameWithOwner.toLowerCase() !==
            originRepository.repositoryNameWithOwner.toLowerCase()
          : false;

      const isTrackingAlias =
        headBranchFromUpstream.length > 0 &&
        details.branch.endsWith(`/${headBranchFromUpstream}`) &&
        details.upstreamRef?.endsWith(`/${details.branch}`);
      const headBranch =
        headBranchFromUpstream &&
        (isCrossRepository ||
          isTrackingAlias ||
          isPullRequestTrackingAlias(details.branch, headBranchFromUpstream))
          ? headBranchFromUpstream
          : details.branch;
      const ownerHeadSelector = remoteRepository.ownerLogin
        ? `${remoteRepository.ownerLogin}:${headBranch}`
        : null;
      const headSelectors: string[] = [];
      appendUnique(headSelectors, headBranch);

      return {
        localBranch: details.branch,
        headBranch,
        headSelectors,
        preferredHeadSelector:
          ownerHeadSelector &&
          (isCrossRepository || isPullRequestTrackingAlias(details.branch, headBranch))
            ? ownerHeadSelector
            : headBranch,
        remoteName,
        headRepositoryNameWithOwner: remoteRepository.repositoryNameWithOwner,
        headRepositoryOwnerLogin: remoteRepository.ownerLogin,
        isCrossRepository,
      } satisfies BranchHeadContext;
    });

  const findOpenPr = (
    cwd: string,
    headContext: BranchHeadContext,
    provider: SourceControlProvider,
  ) =>
    Effect.gen(function* () {
      for (const headSelector of headContext.headSelectors) {
        const pullRequests = yield* provider.listOpenPullRequests({
          cwd,
          headSelector,
          limit: 100,
        });

        const firstPullRequest = pullRequests.find((pr) =>
          matchesBranchHeadContext(pr, headContext),
        );
        if (firstPullRequest) {
          return {
            number: firstPullRequest.number,
            title: firstPullRequest.title,
            url: firstPullRequest.url,
            baseRefName: firstPullRequest.baseRefName,
            headRefName: firstPullRequest.headRefName,
            state: "open",
            updatedAt: null,
            ...toPullRequestHeadRemoteInfo(firstPullRequest),
          } satisfies PullRequestInfo;
        }
      }

      return null;
    });

  const findLatestPr = (
    cwd: string,
    details: { branch: string; upstreamRef: string | null; remoteName?: string },
    provider: SourceControlProvider,
    complete = false,
  ) =>
    Effect.gen(function* () {
      const headContext = yield* resolveBranchHeadContext(cwd, details);
      const parsedByNumber = new Map<number, PullRequestInfo>();

      for (const headSelector of headContext.headSelectors) {
        const pullRequests = yield* provider.listOpenPullRequests({
          cwd,
          headSelector,
          state: "all",
          limit: 100,
        });
        if (complete && pullRequests.length >= (provider.kind === "bitbucket" ? 50 : 100))
          return yield* new GitManagerError({
            operation: "branchPullRequest",
            detail: "The branch PR listing is incomplete.",
          });
        for (const item of pullRequests) {
          const pr = { ...item, state: item.state ?? "open", updatedAt: item.updatedAt ?? null };
          if (!matchesBranchHeadContext(pr, headContext)) continue;
          parsedByNumber.set(pr.number, {
            ...pr,
            ...(pr.isCrossRepository === undefined
              ? { isCrossRepository: headContext.isCrossRepository }
              : {}),
            ...(pr.headRepositoryNameWithOwner === undefined
              ? { headRepositoryNameWithOwner: headContext.headRepositoryNameWithOwner }
              : {}),
            ...(pr.headRepositoryOwnerLogin === undefined
              ? { headRepositoryOwnerLogin: headContext.headRepositoryOwnerLogin }
              : {}),
          });
        }
      }

      const parsed = Array.from(parsedByNumber.values()).toSorted((a, b) => {
        const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return right - left || b.number - a.number;
      });

      const latestOpenPr = parsed.find((pr) => pr.state === "open");
      if (latestOpenPr) {
        return latestOpenPr;
      }
      return parsed[0] ?? null;
    });

  const branchPullRequest: GitManagerShape["branchPullRequest"] = (input) =>
    lookupBranchPullRequest(gitCore, input, (details) =>
      Effect.gen(function* () {
        const identity = yield* resolveSourceControlProviderIdentity(input.cwd);
        if (
          identity.kind === "unknown" ||
          !identity.host ||
          !identity.owner ||
          !identity.repository
        )
          return yield* new GitManagerError({
            operation: "branchPullRequest",
            detail: "The repository forge could not be verified.",
          });
        const repository = `${identity.owner}/${identity.repository}`;
        const permitted = serverSettings.getSettings.pipe(
          Effect.mapError(
            () =>
              new GitHubCliError({
                operation: "branchPullRequest",
                kind: "forbidden",
                detail: "The PR monitoring policy could not be verified.",
              }),
          ),
          Effect.flatMap((current) =>
            isPrHubRepositoryExcluded(current, repository)
              ? Effect.fail(
                  new GitHubCliError({
                    operation: "branchPullRequest",
                    kind: "forbidden",
                    detail: "The repository is excluded from PR monitoring.",
                  }),
                )
              : Effect.void,
          ),
        );
        yield* permitted;
        const parent = yield* Effect.serviceOption(GitHubRequestPolicy);
        const provider = yield* sourceControlProviderForIdentity(identity);
        return yield* findLatestPr(input.cwd, details, provider, true).pipe(
          Effect.tap(() => permitted),
          Effect.provideService(GitHubRequestPolicy, {
            beforeSend: (write) =>
              (Option.isSome(parent) ? parent.value.beforeSend(write) : Effect.void).pipe(
                Effect.andThen(permitted),
              ),
            readInvalidated: Option.isSome(parent) ? parent.value.readInvalidated : Effect.never,
          }),
        );
      }),
    );

  const resolveBaseBranch = (
    cwd: string,
    branch: string,
    upstreamRef: string | null,
    headContext: Pick<BranchHeadContext, "isCrossRepository">,
    provider: SourceControlProvider,
  ) =>
    Effect.gen(function* () {
      const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
      if (configured) return configured;

      if (upstreamRef && !headContext.isCrossRepository) {
        const upstreamBranch = extractBranchNameFromRemoteRef(upstreamRef);
        if (
          upstreamBranch.length > 0 &&
          upstreamBranch !== branch &&
          !isPullRequestTrackingAlias(branch, upstreamBranch)
        ) {
          return upstreamBranch;
        }
      }

      const defaultFromGh = yield* provider
        .getDefaultBranch({ cwd })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (defaultFromGh) {
        return defaultFromGh;
      }

      const remoteDefault = yield* gitCore.readDefaultBranch(cwd);
      if (remoteDefault) return remoteDefault;
      const { branches } = yield* gitCore.listBranches({ cwd });
      return (
        ["main", "master"].find((name) =>
          branches.some((candidate) => !candidate.isRemote && candidate.name === name),
        ) ?? "main"
      );
    });

  const resolveCommitAndBranchSuggestion = (input: {
    settings: ServerSettings;
    cwd: string;
    branch: string | null;
    commitMessage?: string;
    /** When true, also produce a semantic feature branch name. */
    includeBranch?: boolean;
    filePaths?: readonly string[];
    model?: string;
  }) =>
    Effect.gen(function* () {
      const context = yield* gitCore.prepareCommitContext(input.cwd, input.filePaths);
      if (!context) {
        return null;
      }

      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      if (customCommit) {
        return {
          context,
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const writingPreferences = input.settings.sourceControlWriting;
      if (!writingPreferences.generateCommitMessages) {
        const deterministic = buildDeterministicCommitMessage(
          context.stagedSummary,
          writingPreferences,
        );
        return {
          context,
          subject: deterministic.subject,
          body: deterministic.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(deterministic.subject) }
            : {}),
          commitMessage: formatCommitMessage(deterministic.subject, deterministic.body),
        };
      }

      const generated = yield* textGeneration
        .generateCommitMessage({
          modelSelection: input.settings.textGenerationModelSelection,
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
          ...(input.model ? { model: input.model } : {}),
          writingPreferences,
        })
        .pipe(Effect.map((result) => sanitizeCommitMessage(result)));

      return {
        context,
        subject: generated.subject,
        body: writingPreferences.commitMessageIncludeBody ? generated.body : "",
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(
          generated.subject,
          writingPreferences.commitMessageIncludeBody ? generated.body : "",
        ),
      };
    });

  const runCommitStep = (
    settings: ServerSettings,
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
    filePaths?: readonly string[],
    model?: string,
    newBranch?: string,
  ) =>
    Effect.gen(function* () {
      const suggestion =
        preResolvedSuggestion ??
        (yield* resolveCommitAndBranchSuggestion({
          settings,
          cwd,
          branch,
          ...(commitMessage ? { commitMessage } : {}),
          ...(filePaths ? { filePaths } : {}),
          ...(model ? { model } : {}),
        }));
      if (!suggestion) {
        return { status: "skipped_no_changes" as const };
      }

      const result = yield* gitCore.commitPrepared(
        cwd,
        suggestion.subject,
        suggestion.body,
        suggestion.context,
        newBranch ? { newBranch } : undefined,
      );
      if (result.status === "context_changed")
        return {
          status: "context_changed" as const,
          subject: suggestion.subject,
          suggestedMessage: suggestion.commitMessage,
        };
      return {
        status: "created" as const,
        commitSha: result.commitSha,
        subject: suggestion.subject,
      };
    });

  const runPrStep = (
    settings: ServerSettings,
    cwd: string,
    fallbackBranch: string | null,
    model?: string,
  ) =>
    Effect.gen(function* () {
      const sourceControlIdentity = yield* resolveSourceControlProviderIdentity(cwd);
      const sourceControlProvider = yield* sourceControlProviderForIdentity(sourceControlIdentity);
      const details = yield* gitCore.statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* gitManagerError(
          "runPrStep",
          "Cannot create a pull request from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* gitManagerError(
          "runPrStep",
          "Current branch has not been pushed. Push before creating a PR.",
        );
      }

      const headContext = yield* resolveBranchHeadContext(cwd, {
        branch,
        upstreamRef: details.upstreamRef,
      });

      const existing = yield* findOpenPr(cwd, headContext, sourceControlProvider);
      if (existing) {
        return {
          status: "opened_existing" as const,
          url: existing.url,
          number: existing.number,
          baseBranch: existing.baseRefName,
          headBranch: existing.headRefName,
          title: existing.title,
        };
      }

      const baseBranch = yield* resolveBaseBranch(
        cwd,
        branch,
        details.upstreamRef,
        headContext,
        sourceControlProvider,
      );
      const rangeContext = yield* gitCore.readRangeContext(cwd, baseBranch);
      const writingPreferences = settings.sourceControlWriting;
      const generated = writingPreferences.generatePrContent
        ? yield* textGeneration.generatePrContent({
            modelSelection: settings.textGenerationModelSelection,
            cwd,
            baseBranch,
            headBranch: headContext.headBranch,
            commitSummary: limitContext(rangeContext.commitSummary, 20_000),
            diffSummary: limitContext(rangeContext.diffSummary, 20_000),
            diffPatch: limitContext(rangeContext.diffPatch, 60_000),
            ...(model ? { model } : {}),
            writingPreferences,
          })
        : buildDeterministicPrContent({
            headBranch: headContext.headBranch,
            commitSummary: rangeContext.commitSummary,
            diffSummary: rangeContext.diffSummary,
            writingPreferences,
          });

      const bodyFile = path.join(tempDir, `t3code-pr-body-${process.pid}-${randomUUID()}.md`);
      yield* fileSystem
        .writeFileString(bodyFile, generated.body)
        .pipe(
          Effect.mapError((cause) =>
            gitManagerError("runPrStep", "Failed to write pull request body temp file.", cause),
          ),
        );
      yield* sourceControlProvider
        .createPullRequest({
          cwd,
          baseBranch,
          headSelector: headContext.preferredHeadSelector,
          title: generated.title,
          bodyFile,
        })
        .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))));

      const created = yield* findOpenPr(cwd, headContext, sourceControlProvider);
      if (!created) {
        return {
          status: "created" as const,
          baseBranch,
          headBranch: headContext.headBranch,
          title: generated.title,
        };
      }

      return {
        status: "created" as const,
        url: created.url,
        number: created.number,
        baseBranch: created.baseRefName,
        headBranch: created.headRefName,
        title: created.title,
      };
    });

  const status: GitManagerShape["status"] = Effect.fnUntraced(function* (input) {
    if (
      !(yield* fileSystem.exists(input.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              operation: "GitManager.status",
              cwd: input.cwd,
              command: "stat",
              detail: cause.message,
            }),
        ),
      ))
    ) {
      return {
        worktreeMissing: true,
        branch: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
        changeRequest: null,
      };
    }
    const details = yield* gitCore.statusDetails(input.cwd, {
      refreshUpstream: input.includeRemote !== false,
    });
    const sourceControlProvider = yield* resolveSourceControlProviderIdentity(input.cwd);

    const latestPr =
      details.branch !== null &&
      sourceControlProviders.providers.some(
        (provider) =>
          provider.kind === sourceControlProvider.kind || sourceControlProvider.kind === "unknown",
      )
        ? yield* findLatestPr(
            input.cwd,
            {
              branch: details.branch,
              upstreamRef: details.upstreamRef,
            },
            yield* sourceControlProviderForIdentity(sourceControlProvider),
          ).pipe(
            Effect.flatMap((latest) => {
              if (!latest) return Effect.succeed(null);
              if (latest.state === "open") return Effect.succeed(latest);

              return sourceControlProviderForIdentity(sourceControlProvider).pipe(
                Effect.flatMap((provider) => provider.getDefaultBranch({ cwd: input.cwd })),
                Effect.map((defaultBranch) =>
                  defaultBranch !== null && details.branch === defaultBranch ? null : latest,
                ),
                Effect.catch(() => Effect.succeed(latest)),
              );
            }),
            Effect.catch(() => Effect.succeed(null)),
          )
        : null;
    if (latestPr) yield* noteStatusPullRequestState(latestPr);
    const pr = latestPr ? toStatusPr(latestPr) : null;
    const changeRequest = latestPr ? toChangeRequest(latestPr, sourceControlProvider) : null;

    return {
      sourceControl: sourceControlProvider,
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      pr,
      changeRequest,
    };
  });

  const resolvePullRequest: GitManagerShape["resolvePullRequest"] = Effect.fnUntraced(
    function* (input) {
      const sourceControlProvider = yield* resolveSourceControlProviderIdentity(input.cwd);
      const provider = yield* sourceControlProviderForIdentity(sourceControlProvider);
      const resolved = yield* provider.getPullRequest({
        cwd: input.cwd,
        reference: normalizePullRequestReference(input.reference),
      });
      const pullRequest = toResolvedPullRequest(resolved);
      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(resolved),
      };
      return {
        pullRequest,
        changeRequest: toChangeRequest(pullRequestWithRemoteInfo, sourceControlProvider),
      };
    },
  );

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fnUntraced(
    function* (input) {
      const normalizedReference = normalizePullRequestReference(input.reference);
      const rootWorktreePath = canonicalizeExistingPath(input.cwd);
      const sourceControlProvider = yield* resolveSourceControlProviderIdentity(input.cwd);
      const provider = yield* sourceControlProviderForIdentity(sourceControlProvider);
      const pullRequestSummary = yield* provider.getPullRequest({
        cwd: input.cwd,
        reference: normalizedReference,
      });
      const expectedHeadOid = input.expectedHeadOid?.trim().toLowerCase();
      const currentHeadOid = pullRequestSummary.headRefOid?.trim().toLowerCase() ?? null;
      if (expectedHeadOid && currentHeadOid !== expectedHeadOid) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          `Pull request head changed before checkout (expected ${expectedHeadOid}, found ${currentHeadOid ?? "unknown"}). Refresh PR Hub before retrying.`,
        );
      }
      const pullRequest = toResolvedPullRequest(pullRequestSummary);
      const pullRequestWithRemoteInfo = {
        ...pullRequest,
        ...toPullRequestHeadRemoteInfo(pullRequestSummary),
      };
      const changeRequest = toChangeRequest(pullRequestWithRemoteInfo, sourceControlProvider);

      if (input.mode === "local") {
        const initialStatus = yield* gitCore.statusDetails(input.cwd);
        if (initialStatus.hasWorkingTreeChanges)
          return yield* gitManagerError(
            "preparePullRequestThread",
            "Commit or stash working tree changes before checking out a pull request.",
          );
        // Fetch/materialize before transition locking. Never force-checkout a user's files.
        yield* materializePullRequestHeadBranch(input.cwd, pullRequestWithRemoteInfo, provider);
        const switchWorkspace = yield* GitWorkspaceSwitch;
        if (switchWorkspace)
          yield* switchWorkspace({
            cwd: input.cwd,
            branch: pullRequest.headBranch,
            create: false,
          }).pipe(
            Effect.mapError(
              (error) =>
                new GitManagerError({
                  operation: "preparePullRequestThread",
                  detail: error.message,
                }),
            ),
          );
        else
          yield* Effect.scoped(
            gitCore.checkoutBranch({ cwd: input.cwd, branch: pullRequest.headBranch }),
          );
        const details = yield* gitCore.statusDetails(input.cwd);
        yield* configurePullRequestHeadUpstream(
          input.cwd,
          pullRequestWithRemoteInfo,
          provider,
          details.branch ?? pullRequest.headBranch,
        );
        return {
          pullRequest,
          changeRequest,
          branch: details.branch ?? pullRequest.headBranch,
          worktreePath: null,
        };
      }

      const ensureExistingWorktreeUpstream = (worktreePath: string) =>
        Effect.gen(function* () {
          const details = yield* gitCore.statusDetails(worktreePath);
          yield* configurePullRequestHeadUpstream(
            worktreePath,
            pullRequestWithRemoteInfo,
            provider,
            details.branch ?? pullRequest.headBranch,
          );
        });

      const localPullRequestBranch =
        resolvePullRequestWorktreeLocalBranchName(pullRequestWithRemoteInfo);

      const findLocalHeadBranch = (cwd: string) =>
        gitCore.listBranches({ cwd }).pipe(
          Effect.map((result) => {
            const localBranch = result.branches.find(
              (branch) => !branch.isRemote && branch.name === localPullRequestBranch,
            );
            if (localBranch) {
              return localBranch;
            }
            if (localPullRequestBranch === pullRequest.headBranch) {
              return null;
            }
            return (
              result.branches.find(
                (branch) =>
                  !branch.isRemote &&
                  branch.name === pullRequest.headBranch &&
                  branch.worktreePath !== null &&
                  canonicalizeExistingPath(branch.worktreePath) !== rootWorktreePath,
              ) ?? null
            );
          }),
        );

      const existingBranchBeforeFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchBeforeFetchPath = existingBranchBeforeFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchBeforeFetch.worktreePath)
        : null;
      if (
        existingBranchBeforeFetch?.worktreePath &&
        existingBranchBeforeFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchBeforeFetch.worktreePath);
        return {
          pullRequest,
          changeRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchBeforeFetch.worktreePath,
        };
      }
      if (existingBranchBeforeFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      yield* materializePullRequestHeadBranch(
        input.cwd,
        pullRequestWithRemoteInfo,
        provider,
        localPullRequestBranch,
      );

      const existingBranchAfterFetch = yield* findLocalHeadBranch(input.cwd);
      const existingBranchAfterFetchPath = existingBranchAfterFetch?.worktreePath
        ? canonicalizeExistingPath(existingBranchAfterFetch.worktreePath)
        : null;
      if (
        existingBranchAfterFetch?.worktreePath &&
        existingBranchAfterFetchPath !== rootWorktreePath
      ) {
        yield* ensureExistingWorktreeUpstream(existingBranchAfterFetch.worktreePath);
        return {
          pullRequest,
          changeRequest,
          branch: localPullRequestBranch,
          worktreePath: existingBranchAfterFetch.worktreePath,
        };
      }
      if (existingBranchAfterFetchPath === rootWorktreePath) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "This PR branch is already checked out in the main repo. Use Local, or switch the main repo off that branch before creating a worktree thread.",
        );
      }

      const preparationProject = yield* getProject(input.cwd);
      const preparationScript =
        input.runSetupScript === false
          ? null
          : setupProjectScript(preparationProject?.scripts ?? []);
      const worktree = yield* gitCore.createWorktree({
        preparation: {
          owner: `pr:${localPullRequestBranch}`,
          runSetupScript: preparationScript !== null,
          setupIdentity: preparationScript?.command ?? null,
        },
        submodules: (yield* getProjectSettings(input.cwd)).worktreeSubmodules,
        cwd: input.cwd,
        branch: localPullRequestBranch,
        path: yield* gitCore.allocateWorktreePath({
          cwd: input.cwd,
          branch: localPullRequestBranch,
        }),
      });
      yield* ensureExistingWorktreeUpstream(worktree.worktree.path);

      return {
        pullRequest,
        changeRequest,
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
      };
    },
  );

  const runFeatureBranchStep = (
    settings: ServerSettings,
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    filePaths?: readonly string[],
    model?: string,
  ) =>
    Effect.gen(function* () {
      const suggestion = yield* resolveCommitAndBranchSuggestion({
        settings,
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        ...(filePaths ? { filePaths } : {}),
        includeBranch: true,
        ...(model ? { model } : {}),
      });
      if (!suggestion) {
        return yield* gitManagerError(
          "runFeatureBranchStep",
          "Cannot create a feature branch because there are no changes to commit.",
        );
      }

      const writingPreferences = settings.sourceControlWriting;
      const generatedBranch = suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
      const preferredBranch = sanitizeFeatureBranchName(
        prefixGeneratedBranchName(generatedBranch, writingPreferences),
      );
      const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
      const resolvedBranch = resolveAutoFeatureBranchName(existingBranchNames, preferredBranch);

      const switchWorkspace = yield* GitWorkspaceSwitch;
      if (switchWorkspace)
        yield* switchWorkspace({ cwd, branch: resolvedBranch, create: true }).pipe(
          Effect.mapError(
            (error) =>
              new GitManagerError({ operation: "runFeatureBranchStep", detail: error.message }),
          ),
        );

      return {
        branchStep: { status: "created" as const, name: resolvedBranch },
        workspaceSwitched: switchWorkspace !== null,
        resolvedCommitMessage: suggestion.commitMessage,
        resolvedCommitSuggestion: suggestion,
      };
    });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fnUntraced(
    function* (input, _options) {
      const settings = yield* getProjectSettings(input.cwd);
      const wantsPush = input.action !== "commit";
      const wantsPr = input.action === "commit_push_pr";

      const initialStatus = yield* gitCore.statusDetails(input.cwd);
      if (!input.featureBranch && wantsPush && !initialStatus.branch) {
        return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
      }
      if (!input.featureBranch && wantsPr && !initialStatus.branch) {
        return yield* gitManagerError(
          "runStackedAction",
          "Cannot create a pull request from detached HEAD.",
        );
      }

      let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
      let workspaceSwitched = false;
      let commitMessageForStep = input.commitMessage;
      let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

      if (input.featureBranch) {
        const result = yield* runFeatureBranchStep(
          settings,
          input.cwd,
          initialStatus.branch,
          input.commitMessage,
          input.filePaths,
          input.textGenerationModel,
        );
        branchStep = result.branchStep;
        workspaceSwitched = result.workspaceSwitched;
        commitMessageForStep = result.resolvedCommitMessage;
        preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
      } else {
        branchStep = { status: "skipped_not_requested" as const };
      }

      const currentBranch = branchStep.name ?? initialStatus.branch;

      const commit = yield* runCommitStep(
        settings,
        input.cwd,
        currentBranch,
        commitMessageForStep,
        preResolvedCommitSuggestion,
        input.filePaths,
        input.textGenerationModel,
        input.featureBranch && !workspaceSwitched ? branchStep.name : undefined,
      );
      if (commit.status === "context_changed")
        return {
          action: input.action,
          branch: workspaceSwitched ? branchStep : { status: "skipped_not_requested" as const },
          commit,
          push: { status: "skipped_not_requested" as const },
          pr: { status: "skipped_not_requested" as const },
        };

      const push = wantsPush
        ? yield* gitCore.pushCurrentBranch(input.cwd, currentBranch)
        : { status: "skipped_not_requested" as const };

      const pr = wantsPr
        ? yield* runPrStep(settings, input.cwd, currentBranch, input.textGenerationModel)
        : { status: "skipped_not_requested" as const };

      return {
        action: input.action,
        branch: branchStep,
        commit,
        push,
        pr,
      };
    },
  );

  return {
    status,
    pullRequestStateChanges: Stream.fromPubSub(pullRequestStateChanges),
    branchPullRequest,
    resolvePullRequest,
    preparePullRequestThread,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager);
