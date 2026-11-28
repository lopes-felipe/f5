import {
  recordCertifies,
  type ProviderIntegration,
  type ProviderIntegrationRecord,
} from "@t3tools/shared/providerIntegrationCertification";

const INTEGRATIONS: ReadonlyArray<ProviderIntegration> = [
  "claude-chrome",
  "codex-chrome",
  "codex-computer",
];

export interface PromotionIo {
  /** File contents at a git revision, or undefined when the path doesn't exist there. */
  readonly show: (revision: string, path: string) => string | undefined;
  readonly commitOf: (revision: string) => string;
  readonly isAncestor: (commit: string, revision: string) => boolean;
  readonly release: (tag: string) => { readonly isDraft: boolean };
}

/**
 * Everything that must hold before a draft is published: it is still a draft, and every
 * certifying record's evidence commit is in the tag's history. Per-build operator
 * acceptance (`integrations:accept`) is optional and never blocks publication.
 */
export function promotionProblems(tag: string, io: PromotionIo): string[] {
  const problems: string[] = [];
  if (!io.release(tag).isDraft) return [`${tag} is already published.`];
  // Records are read at the commit the remote tag names: the draft was built from it.
  const tagCommit = io.commitOf(tag);
  for (const integration of INTEGRATIONS) {
    const text = io.show(
      tagCommit,
      `packages/shared/src/certification/${integration}.generated.json`,
    );
    const records = (text ? JSON.parse(text) : []) as ProviderIntegrationRecord[];
    for (const record of records.filter(recordCertifies))
      if (!io.isAncestor(record.evidenceCommit!, tagCommit))
        problems.push(`${record.id}: evidence commit is not in ${tag}'s history`);
  }
  return problems;
}

/**
 * The commit `refs/tags/<tag>` names on the remote (peeled for annotated tags). A local
 * tag that differs is refused rather than trusted: it may be stale or moved.
 */
export function remoteTagCommit(
  tag: string,
  git: { readonly local: (tag: string) => string; readonly remote: (tag: string) => string },
): string {
  const refs = new Map(
    git
      .remote(tag)
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([sha, ref]) => [ref, sha]),
  );
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error(`origin has no tag ${tag}.`);
  const local = git.local(tag);
  if (local !== commit)
    throw new Error(`Local tag ${tag} (${local}) differs from origin's (${commit}). Refetch it.`);
  return commit;
}

/**
 * The source commit a tagless draft names. Publishers create drafts without a tag (it is
 * created only right before promotion) and record the source in `target_commitish`. Only
 * a full commit SHA counts: older drafts carry a branch name such as `main` there.
 */
export interface DraftIdentity {
  readonly draft: boolean;
  readonly target_commitish?: string | null | undefined;
}
export function draftSourceCommit(release: DraftIdentity): string | undefined {
  const target = release.target_commitish ?? "";
  return release.draft && /^[a-f0-9]{40}$/.test(target) ? target : undefined;
}

/**
 * The commit a release is published from. A remote tag is authoritative (published
 * releases and drafts reserved by older publishers). A tagless draft names its source in
 * `target_commitish`; `needsTag` then tells the caller to create the tag at that commit
 * immediately before undrafting.
 */
export function promotionSource(
  tag: string,
  io: {
    readonly tagExists: () => boolean;
    readonly remoteTagCommit: () => string;
    readonly release: () => DraftIdentity;
  },
): { readonly commit: string; readonly needsTag: boolean } {
  if (io.tagExists()) return { commit: io.remoteTagCommit(), needsTag: false };
  const commit = draftSourceCommit(io.release());
  if (!commit)
    throw new Error(`origin has no tag ${tag}, and it is not a draft naming a source commit.`);
  return { commit, needsTag: true };
}
