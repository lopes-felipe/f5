const FALLBACK = "The host refused the review. Your draft is still here to try again.";

export function reviewFailureDescription(failure: unknown): string {
  const raw =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  const detail = raw.replace(/^Pull request operation(?: \w+)? failed:\s*/iu, "").trim();
  if (
    !detail ||
    /^(?:github\s*)?(?:cli|api)?\s*(?:command\s*)?failed\.?$/iu.test(detail) ||
    /^exited? with (code|status) \d+\.?$/iu.test(detail) ||
    /^unknown error\.?$/iu.test(detail)
  )
    return FALLBACK;
  return detail.length <= 320 ? detail : detail.slice(0, 319) + "…";
}
