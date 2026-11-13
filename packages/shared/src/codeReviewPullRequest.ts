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
// Only an explicit PR phrase counts: `PR 123`, `PR #123`, `PR#123`,
// `pull request 123`. A bare `#123` is too often an issue, a rank or a colour.
const SHORTHAND_PATTERN = /(?:^|[^\w/&#])(?:pr\s*#?|pull\s+request\s+#?)(\d{1,9})\b/gi;

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

/** The PR link the merge model is asked to put in the report's title. */
export function codeReviewPullRequestMarkdownLink(pullRequest: CodeReviewPullRequest): string {
  return `[${codeReviewPullRequestLabel(pullRequest)}](${pullRequest.url})`;
}

export function codeReviewPostFooter(slots: {
  readonly reviewerA: Pick<WorkflowModelSlot, "model">;
  readonly reviewerB: Pick<WorkflowModelSlot, "model">;
  readonly consolidation: Pick<WorkflowModelSlot, "model">;
}): string {
  return `<sub>Posted by F5 code review · Reviewers: ${slots.reviewerA.model}, ${slots.reviewerB.model} · Merge: ${slots.consolidation.model}</sub>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linksPullRequest(line: string, url: string): boolean {
  // `…/pull/12` must not match `…/pull/123`.
  return new RegExp(`${escapeRegExp(url)}(?!\\d)`).test(line);
}

/** How many leading non-empty lines count as the report's opening. */
const REPORT_OPENING_LINES = 4;

/**
 * The merged review as shown and posted.
 *
 * - Narration the model wrote before a title or header line that links the PR
 *   ("I checked the claims and am now writing the report.") is dropped.
 * - When the opening does not link the PR, a `**Reviewed PR:**` line is added,
 *   below the title when the report starts with one.
 */
export function formatCodeReviewReport(
  text: string,
  options: {
    readonly pullRequest: CodeReviewPullRequest | null | undefined;
    readonly footer?: string | undefined;
  },
): string {
  const footer = options.footer ? `\n\n---\n\n${options.footer}` : "";
  const pullRequest = options.pullRequest;
  let body = text.trim();
  if (!pullRequest) return `${body}${footer}`;

  const lines = body.split("\n");
  const anchor = lines.findIndex(
    (line) =>
      /^(#{1,3}\s|\*\*Reviewed PR:\*\*)/.test(line.trim()) &&
      linksPullRequest(line, pullRequest.url),
  );
  if (anchor > 0) body = lines.slice(anchor).join("\n").trim();

  const opening = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, REPORT_OPENING_LINES);
  if (opening.some((line) => linksPullRequest(line, pullRequest.url))) return `${body}${footer}`;

  const header = `**Reviewed PR:** ${codeReviewPullRequestMarkdownLink(pullRequest)}`;
  const [first = "", ...rest] = body.split("\n");
  const withHeader = /^#\s/.test(first)
    ? `${first}\n\n${header}\n\n${rest.join("\n").trim()}`
    : `${header}\n\n${body}`;
  return `${withHeader.trim()}${footer}`;
}
