import type {
  CodeReviewPullRequest,
  SourceControlPullRequestRef,
  WorkflowModelSlot,
} from "@t3tools/contracts";

import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
  parseSourceControlPullRequestUrl,
  parseSourceControlRemoteUrl,
} from "./sourceControl";

/** GitHub caps comment bodies at 65,536 characters; PR Hub appends a marker. */
export const CODE_REVIEW_POST_BODY_MAX_CHARS = 65_400;

export type CodeReviewPullRequestTarget =
  | { readonly kind: "url"; readonly ref: SourceControlPullRequestRef; readonly url: string }
  | { readonly kind: "number"; readonly number: number };

const URL_PATTERN = /https:\/\/[^\s<>()[\]{}"'`]+/g;
// `#123`, `PR 123`, `PR #123`, `PR#123`, `pull request 123`. A leading word
// character, `/`, `&` (HTML entities) or `#` rules out fragments and paths.
const SHORTHAND_PATTERN = /(?:^|[^\w/&#])(?:#|\bpr\s*#?|\bpull\s+request\s+#?)(\d{1,9})\b/gi;

/** HTTPS URLs in prompt order, without trailing sentence punctuation. */
export function codeReviewPromptUrls(prompt: string): string[] {
  return [...prompt.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;:!?]+$/, ""));
}

/** The single PR number named by shorthand, or null when none or several appear. */
export function detectCodeReviewPullRequestShorthand(prompt: string): number | null {
  const withoutUrls = prompt.replace(URL_PATTERN, " ");
  const numbers = new Set<number>();
  for (const match of withoutUrls.matchAll(SHORTHAND_PATTERN)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > 0) numbers.add(value);
  }
  return numbers.size === 1 ? [...numbers][0]! : null;
}

/**
 * The review target named in free-text review instructions. The first PR URL
 * wins; otherwise an unambiguous shorthand number, resolved later against the
 * project's remote.
 */
export function detectCodeReviewPullRequestTarget(
  prompt: string,
): CodeReviewPullRequestTarget | null {
  for (const candidate of codeReviewPromptUrls(prompt)) {
    const ref = parseSourceControlPullRequestUrl(candidate);
    if (ref) return { kind: "url", ref, url: canonicalPullRequestUrl(ref, candidate) };
  }
  const number = detectCodeReviewPullRequestShorthand(prompt);
  return number === null ? null : { kind: "number", number };
}

/** The PR's web URL without trailing tabs (`/files`), query or fragment. */
export function canonicalPullRequestUrl(ref: SourceControlPullRequestRef, rawUrl?: string): string {
  if (ref.provider === "github") {
    return `https://${ref.host}/${ref.repository}/pull/${ref.number}`;
  }
  if (!rawUrl) return `https://${ref.host}/${ref.repository}`;
  try {
    const url = new URL(rawUrl);
    const end = url.pathname.search(new RegExp(`/${ref.number}(?:/|$)`));
    const pathname = end < 0 ? url.pathname : url.pathname.slice(0, end + `/${ref.number}`.length);
    return `${url.origin}${pathname}`;
  } catch {
    return rawUrl;
  }
}

export function codeReviewPullRequestFromRef(
  ref: SourceControlPullRequestRef,
  rawUrl?: string,
): CodeReviewPullRequest {
  return {
    url: canonicalPullRequestUrl(ref, rawUrl),
    key: formatSourceControlPullRequestKey(ref),
  };
}

/** Resolve a shorthand PR number against a GitHub remote URL. */
export function githubPullRequestFromRemote(
  remoteUrl: string | null | undefined,
  number: number,
): CodeReviewPullRequest | null {
  const remote = parseSourceControlRemoteUrl(remoteUrl);
  if (remote.kind !== "github" || !remote.host || !remote.owner || !remote.repository) {
    return null;
  }
  return codeReviewPullRequestFromRef({
    provider: "github",
    host: remote.host.toLowerCase(),
    repository: `${remote.owner}/${remote.repository}`,
    number,
  });
}

export function codeReviewPullRequestRef(
  pullRequest: CodeReviewPullRequest | null | undefined,
): SourceControlPullRequestRef | null {
  return pullRequest ? parseSourceControlPullRequestKey(pullRequest.key) : null;
}

export function isGitHubCodeReviewPullRequest(
  pullRequest: CodeReviewPullRequest | null | undefined,
): pullRequest is CodeReviewPullRequest {
  return codeReviewPullRequestRef(pullRequest)?.provider === "github";
}

/** `owner/repo#123`, falling back to the URL when the key is unreadable. */
export function codeReviewPullRequestLabel(pullRequest: CodeReviewPullRequest): string {
  const ref = codeReviewPullRequestRef(pullRequest);
  return ref ? `${ref.repository}#${ref.number}` : pullRequest.url;
}

/** The exact first line the consolidation model is asked to write. */
export function codeReviewReportHeaderLine(pullRequest: CodeReviewPullRequest): string {
  return `**Reviewed PR:** ${pullRequest.url}`;
}

export function codeReviewPostFooter(slots: {
  readonly reviewerA: Pick<WorkflowModelSlot, "model">;
  readonly reviewerB: Pick<WorkflowModelSlot, "model">;
  readonly consolidation: Pick<WorkflowModelSlot, "model">;
}): string {
  return `<sub>Posted by F5 code review · Reviewers: ${slots.reviewerA.model}, ${slots.reviewerB.model} · Merge: ${slots.consolidation.model}</sub>`;
}

/**
 * The merged review as shown and posted. A PR link header is added only when
 * the model left the PR URL out, so the report always names its target.
 */
export function formatCodeReviewReport(
  text: string,
  options: {
    readonly pullRequest: CodeReviewPullRequest | null | undefined;
    readonly footer?: string | undefined;
  },
): string {
  const body = text.trim();
  const pullRequest = options.pullRequest;
  const header =
    pullRequest && !body.includes(pullRequest.url)
      ? `**Reviewed PR:** [${codeReviewPullRequestLabel(pullRequest)}](${pullRequest.url})\n\n`
      : "";
  const footer = options.footer ? `\n\n---\n\n${options.footer}` : "";
  return `${header}${body}${footer}`;
}
