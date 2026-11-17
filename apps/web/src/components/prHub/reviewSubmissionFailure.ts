export function reviewSubmissionFailure(failure: unknown, fallback: string): string {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  return raw.replace(/^Pull request operation failed[:.\s]*/i, "").trim() || fallback;
}
