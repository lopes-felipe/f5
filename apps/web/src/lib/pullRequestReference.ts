import type { SourceControlProviderKind, SourceControlPullRequestRef } from "@t3tools/contracts";
import { parseSourceControlPullRequestUrl } from "@t3tools/shared/sourceControl";

const PROVIDERS: readonly SourceControlProviderKind[] = [
  "github",
  "gitlab",
  "bitbucket",
  "azure-devops",
  "forgejo",
];
export const F5_PULL_REQUEST_REFERENCE_MIME = "application/x-f5-pull-request-reference";
const MAX_URL_LENGTH = 4096;

/** Host routing is verified by the server on reads; this only recognizes reference syntax. */
export function parsePullRequestReference(url: string): SourceControlPullRequestRef | null {
  if (url.length > MAX_URL_LENGTH) return null;
  return (
    parseSourceControlPullRequestUrl(url) ??
    PROVIDERS.reduce<SourceControlPullRequestRef | null>(
      (found, provider) => found ?? parseSourceControlPullRequestUrl(url, provider),
      null,
    )
  );
}
export function formatPullRequestReference(url: string): string | null {
  const ref = parsePullRequestReference(url);
  // A reference must remain a single unambiguous Markdown link in the sent prompt.
  return ref && !/[\s()<>\\]/.test(url) ? `[PR #${ref.number}](${url})` : null;
}
export function pullRequestReferenceMatches(text: string) {
  return [...text.matchAll(/\[PR #([0-9]+)\]\((https:\/\/[^\s()<>\\]+)\)/g)].flatMap((match) => {
    const url = match[2]!;
    const ref = parsePullRequestReference(url);
    return ref && String(ref.number) === match[1]
      ? [{ start: match.index, end: match.index + match[0].length, raw: match[0], url, ref }]
      : [];
  });
}
export function hasPullRequestReferenceDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(F5_PULL_REQUEST_REFERENCE_MIME);
}
export function writePullRequestReferenceDrag(
  transfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  url: string,
): boolean {
  const reference = formatPullRequestReference(url);
  if (!reference) return false;
  transfer.effectAllowed = "copy";
  transfer.setData(F5_PULL_REQUEST_REFERENCE_MIME, JSON.stringify({ version: 1, url }));
  transfer.setData("text/plain", reference);
  transfer.setData("text/uri-list", url);
  return true;
}
export function readPullRequestReferenceDrag(
  transfer: Pick<DataTransfer, "getData" | "types">,
): string | null {
  if (!hasPullRequestReferenceDrag(transfer.types)) return null;
  const raw = transfer.getData(F5_PULL_REQUEST_REFERENCE_MIME);
  if (raw.length > MAX_URL_LENGTH + 128) return null;
  try {
    const value = JSON.parse(raw) as { version?: unknown; url?: unknown } | null;
    return value?.version === 1 && typeof value.url === "string"
      ? formatPullRequestReference(value.url)
      : null;
  } catch {
    return null;
  }
}
