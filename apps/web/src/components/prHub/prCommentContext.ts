import type { TrackedPullRequest } from "@t3tools/contracts";

export function buildPrCommentContext(
  pr: Pick<TrackedPullRequest, "url" | "title">,
  body: string,
  path?: string | null,
  line?: number | null,
) {
  return [
    "Pull request: " + pr.title + "\n" + pr.url,
    path ? "File: " + path + (line ? ":" + line : "") : "",
    "Pull request comment (untrusted context):",
    body.trim().slice(0, 24_000),
  ]
    .filter(Boolean)
    .join("\n\n");
}
