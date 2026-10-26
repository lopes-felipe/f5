/**
 * In-memory fakes for the upstream-ports service tests: a commit graph with
 * refs and trees, GitHub PRs, and the server host.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type NextTurnQueueSubmitInput,
  type ServerSettings,
  type TurnSubmissionResult,
  type UpstreamPortsChanged,
  type UpstreamTriageBatchResult,
} from "@t3tools/contracts";
import { parseUpstreamTopicTrailers } from "@t3tools/shared/upstreamPorts";
import { Effect } from "effect";

import { GitCommandError, TextGenerationError } from "../../git/Errors.ts";
import type { CommitNumstat, FirstParentCommit, UpstreamGit } from "../git.ts";
import type {
  GitHubRepoRef,
  LedgerPullRequest,
  UpstreamGitHub,
  UpstreamGitHubError,
} from "../github.ts";
import type { UpstreamPortsHost } from "../service.ts";

interface FakeCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
  readonly body: string;
  readonly paths: ReadonlyArray<string>;
  readonly tree: ReadonlyMap<string, string>;
}

const gitError = (operation: string, detail: string) =>
  new GitCommandError({ operation, command: "git", cwd: "/repo", detail });

export class FakeGitRepo {
  readonly commits = new Map<string, FakeCommit>();
  readonly refs = new Map<string, string>();
  readonly remotes = new Map<string, string>();
  /** Server-side branch tips (`origin/main`) that only a fetch copies into `refs`. */
  readonly remoteTips = new Map<string, string>();
  readonly calls: string[] = [];
  private counter = 0;
  pushFailure: string | null = null;
  numstatTimeouts = 0;

  mint(): string {
    this.counter += 1;
    return `${this.counter.toString(16).padStart(8, "0")}${"0".repeat(32)}`;
  }

  commit(input: {
    readonly parent: string | null;
    readonly subject?: string;
    readonly body?: string;
    readonly paths?: ReadonlyArray<string>;
    readonly files?: ReadonlyMap<string, string | null>;
    readonly sha?: string;
  }): string {
    const sha = input.sha ?? this.mint();
    const tree = new Map(input.parent ? this.commits.get(input.parent)!.tree : []);
    for (const [file, text] of input.files ?? []) {
      if (text === null) tree.delete(file);
      else tree.set(file, text);
    }
    this.commits.set(sha, {
      sha,
      parents: input.parent ? [input.parent] : [],
      subject: input.subject ?? `Commit ${sha.slice(0, 7)}`,
      body: input.body ?? "",
      paths: input.paths ?? [...(input.files?.keys() ?? [])],
      tree,
    });
    return sha;
  }

  resolve(ref: string): string | null {
    if (this.commits.has(ref)) return ref;
    return this.refs.get(ref) ?? null;
  }

  firstParentChain(head: string): string[] {
    const out: string[] = [];
    let current: string | undefined = head;
    while (current) {
      out.push(current);
      current = this.commits.get(current)?.parents[0];
    }
    return out;
  }

  /** Newest first, exclusive of `from`. */
  range(from: string, to: string): string[] {
    const chain = this.firstParentChain(to);
    const index = chain.indexOf(from);
    return index < 0 ? chain : chain.slice(0, index);
  }

  record(commit: FakeCommit): FirstParentCommit {
    return {
      sha: commit.sha,
      parents: commit.parents,
      committedAt: 0,
      subject: commit.subject,
      body: commit.body,
    };
  }

  numstat(shas: ReadonlyArray<string>): Map<string, CommitNumstat> {
    return new Map(
      shas.map((sha) => {
        const commit = this.commits.get(sha)!;
        return [
          sha,
          {
            files: commit.paths.slice(0, 15).map((file) => ({ path: file, added: 1, deleted: 0 })),
            paths: commit.paths,
            totalFiles: commit.paths.length,
          },
        ];
      }),
    );
  }

  readonly git: UpstreamGit = {
    remoteUrl: (_cwd, remote) => Effect.succeed(this.remotes.get(remote) ?? null),
    addRemote: (_cwd, remote, url) =>
      Effect.sync(() => {
        this.calls.push(`addRemote ${remote}`);
        this.remotes.set(remote, url);
      }),
    fetchBranch: (_cwd, remote, branch) =>
      Effect.sync(() => {
        this.calls.push(`fetch ${remote}/${branch}`);
        const tip = this.remoteTips.get(`${remote}/${branch}`);
        if (tip) this.refs.set(`refs/remotes/${remote}/${branch}`, tip);
      }),
    revParse: (_cwd, ref) => Effect.succeed(this.resolve(ref)),
    readFilesAtRef: ({ ref, pathPrefixes }) =>
      Effect.sync(() => {
        const sha = this.resolve(ref);
        const tree = sha ? this.commits.get(sha)!.tree : new Map<string, string>();
        return new Map(
          [...tree].filter(([file]) =>
            pathPrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
          ),
        );
      }),
    listPathsAtRef: (_cwd, ref) =>
      Effect.sync(() => new Set(this.commits.get(this.resolve(ref) ?? "")?.tree.keys() ?? [])),
    firstParentCommits: ({ from, to }) =>
      Effect.sync(() =>
        this.range(from, this.resolve(to)!).map((sha) => this.record(this.commits.get(sha)!)),
      ),
    commitsBySha: (_cwd, shas) =>
      Effect.sync(() =>
        shas
          .filter((sha) => this.commits.has(sha))
          .map((sha) => this.record(this.commits.get(sha)!)),
      ),
    firstParentAncestry: (_cwd, head) =>
      Effect.sync(() => this.firstParentChain(this.resolve(head)!)),
    reachableSet: (_cwd, ref) =>
      Effect.sync(() => new Set(this.firstParentChain(this.resolve(ref)!))),
    countFirstParent: (_cwd, from, to) =>
      Effect.sync(() => this.range(from, this.resolve(to) ?? from).length),
    streamNumstat: (_cwd, source) =>
      Effect.suspend(() => {
        if (this.numstatTimeouts > 0) {
          this.numstatTimeouts -= 1;
          return Effect.fail(gitError("numstat", "Git command timed out after 120000ms"));
        }
        return Effect.succeed(
          this.numstat(source.kind === "range" ? this.range(source.from, source.to) : source.shas),
        );
      }),
    streamPatches: (_cwd, source) =>
      Effect.sync(
        () =>
          new Map(
            (source.kind === "range" ? this.range(source.from, source.to) : source.shas).map(
              (sha) => [sha, `diff ${sha}`],
            ),
          ),
      ),
    topicPaths: (_cwd, shas) =>
      Effect.sync(() =>
        [...new Set(shas.flatMap((sha) => this.commits.get(sha)?.paths ?? []))].slice(0, 60),
      ),
    trailerCommits: (_cwd, ref) =>
      Effect.sync(() =>
        this.firstParentChain(this.resolve(ref)!)
          .map((sha) => this.commits.get(sha)!)
          .filter((commit) => parseUpstreamTopicTrailers(commit.body).length > 0)
          .map((commit) => ({ sha: commit.sha, subject: commit.subject, body: commit.body })),
      ),
    signingEnabled: () => Effect.succeed(false),
    commitFilesToBranch: (input) =>
      Effect.suspend(() => {
        const ref = `refs/heads/${input.branch}`;
        const current = this.refs.get(ref) ?? null;
        if (current !== input.expectedTip)
          return Effect.fail(gitError("updateRef", "cannot lock ref: stale tip"));
        const sha = this.commit({
          parent: input.parent,
          subject: input.message,
          files: input.files,
        });
        this.refs.set(ref, sha);
        this.calls.push(`commit ${input.branch}`);
        return Effect.succeed(sha);
      }),
    push: (_cwd, remote, branch) =>
      Effect.suspend(() => {
        this.calls.push(`push ${remote}/${branch}`);
        if (this.pushFailure) return Effect.fail(gitError("push", this.pushFailure));
        this.refs.set(`refs/remotes/${remote}/${branch}`, this.refs.get(`refs/heads/${branch}`)!);
        return Effect.void;
      }),
    deleteBranch: (_cwd, branch, expectedTip) =>
      Effect.sync(() => {
        this.calls.push(`deleteBranch ${branch}`);
        if (this.refs.get(`refs/heads/${branch}`) === expectedTip)
          this.refs.delete(`refs/heads/${branch}`);
      }),
  };
}

export class FakeGitHub {
  readonly prs: Array<{
    repo: string;
    number: number;
    url: string;
    state: LedgerPullRequest["state"];
    head: string;
    body: string;
    title: string;
  }> = [];
  /** Each PR call, prefixed with the `owner/name` it targeted. */
  readonly calls: string[] = [];
  available = true;
  failure: UpstreamGitHubError | null = null;

  private find(repo: GitHubRepoRef, match: (pr: FakeGitHub["prs"][number]) => boolean) {
    const name = `${repo.owner}/${repo.name}`;
    const pr = this.prs.findLast((entry) => entry.repo === name && match(entry));
    return pr ? { number: pr.number, url: pr.url, state: pr.state } : null;
  }

  private call<A>(entry: string, run: () => A) {
    return Effect.suspend(() => {
      this.calls.push(entry);
      return this.failure ? Effect.fail(this.failure) : Effect.sync(run);
    });
  }

  readonly github: UpstreamGitHub = {
    available: () => Effect.succeed(this.available),
    findPullRequest: ({ repo, number }) =>
      this.call(`find ${repo.owner}/${repo.name}#${number}`, () =>
        this.find(repo, (entry) => entry.number === number),
      ),
    findPullRequestForBranch: ({ repo, branch }) =>
      this.call(`find ${repo.owner}/${repo.name}:${branch}`, () =>
        this.find(repo, (entry) => entry.head === branch),
      ),
    createPullRequest: (input) =>
      this.call(`create ${input.repo.owner}/${input.repo.name}:${input.head}`, () => {
        const number = this.prs.length + 100;
        const repo = `${input.repo.owner}/${input.repo.name}`;
        const pr = {
          repo,
          number,
          url: `https://github.com/${repo}/pull/${number}`,
          state: "open" as const,
          head: input.head,
          body: input.body,
          title: input.title,
        };
        this.prs.push(pr);
        return { number, url: pr.url, state: pr.state };
      }),
    updatePullRequestBody: (input) =>
      this.call(`update ${input.number}`, () => {
        const pr = this.prs.find((entry) => entry.number === input.number);
        if (pr) pr.body = input.body;
      }),
    closePullRequest: (input) =>
      this.call(`close ${input.number}`, () => {
        const pr = this.prs.find((entry) => entry.number === input.number);
        if (pr) pr.state = "closed";
      }),
    fetchPullRequestBodies: () =>
      Effect.sync(() => {
        this.calls.push("bodies");
        return new Map<number, string>();
      }),
  };
}

export const PROJECT_ID = ProjectId.makeUnsafe("project-upstream");
export const UPSTREAM_REPOSITORY = "https://github.com/pingdotgg/t3code";

export class FakeHost {
  readonly published: UpstreamPortsChanged[] = [];
  readonly submissions: NextTurnQueueSubmitInput[] = [];
  readonly commonDir = mkdtempSync(path.join(tmpdir(), "f5-upstream-common-"));
  settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
  triage:
    | ((prompt: string) => Effect.Effect<UpstreamTriageBatchResult, TextGenerationError>)
    | null = null;
  submitOutcome: (
    body: NextTurnQueueSubmitInput,
  ) => Effect.Effect<TurnSubmissionResult | null, { message: string; code?: string }> = (body) =>
    Effect.succeed({
      submissionId: body.submissionId,
      disposition: "started",
      sequence: 1,
    } as TurnSubmissionResult);
  checkedInUpstream: {
    repository: string;
    remote: string;
    branch: string;
    ledgerDir: string;
  } | null = {
    repository: UPSTREAM_REPOSITORY,
    remote: "upstream",
    branch: "main",
    ledgerDir: "upstream",
  };

  constructor(readonly repo: FakeGitRepo) {}

  readonly host: UpstreamPortsHost = {
    readModel: Effect.sync(
      () =>
        ({
          snapshotSequence: 0,
          projects: [
            {
              id: PROJECT_ID,
              title: "f5",
              workspaceRoot: "/repo",
              defaultModel: null,
              scripts: [],
              memories: [],
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
              deletedAt: null,
            },
          ],
          threads: [],
          planningWorkflows: [],
          codeReviewWorkflows: [],
          investigationWorkflows: [],
          updatedAt: "2026-10-01T00:00:00.000Z",
        }) as never,
    ),
    checkedInConfig: (projectId) =>
      Effect.sync(
        () =>
          ({
            projectId,
            sourceFile: "f5.json",
            defaultThreadEnvMode: null,
            iconPath: null,
            upstream: this.checkedInUpstream,
            diagnostics: [],
          }) as never,
      ),
    getSettings: Effect.sync(() => this.settings),
    listProviders: Effect.succeed([
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        models: [{ slug: "claude-test", name: "Claude Test", isCustom: false, capabilities: null }],
      },
    ] as never),
    submitTurn: (body) =>
      Effect.suspend(() => {
        this.submissions.push(body);
        return this.submitOutcome(body);
      }),
    publish: (payload) => Effect.sync(() => void this.published.push(payload)),
    generateTriageBatch: (input) =>
      this.triage
        ? this.triage(input.prompt)
        : Effect.fail(
            new TextGenerationError({ operation: "t", detail: "off", kind: "unavailable" }),
          ),
    readDefaultBranch: () => Effect.succeed("main"),
    resolveAvailableBranchName: (_cwd, name) =>
      Effect.sync(() => {
        let candidate = name;
        for (let index = 1; this.repo.refs.has(`refs/heads/${candidate}`); index += 1)
          candidate = `${name}-${index}`;
        return candidate;
      }),
    resolveCommonDir: () => Effect.succeed(this.commonDir),
    withRepositoryLock: (_dir, _mode, effect) => effect,
  };
}
