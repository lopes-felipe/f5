export function reviewSubmissionFailure(failure: unknown, fallback: string): string {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  const detail = raw.trim() || fallback;
  return detail.length <= 320 ? detail : `${detail.slice(0, 319)}…`;
}
