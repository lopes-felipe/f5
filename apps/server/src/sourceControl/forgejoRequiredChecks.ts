import type { PrHubCheck } from "@t3tools/contracts";

// Forgejo uses glob patterns with no separator: * includes slashes.
const unsupportedGlob = /[[\]{}\\]/;
// Avoid regex backtracking on required patterns with many wildcards.
const matchesContext = (glob: string, name: string) => {
  const pattern = Array.from(glob);
  const text = Array.from(name);
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    // Wildcard first, including when the check name contains a literal '*'.
    if (pattern[p] === "*") {
      star = p++;
      resume = t;
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
};

export function markRequiredForgejoChecks(
  checks: ReadonlyArray<PrHubCheck>,
  branch: Readonly<Record<string, unknown>>,
): ReadonlyArray<PrHubCheck> {
  const contexts =
    branch.enable_status_check === true && Array.isArray(branch.status_check_contexts)
      ? branch.status_check_contexts.filter((value): value is string => typeof value === "string")
      : [];
  if (!contexts.length) return checks;
  const unsupported = [...new Set(contexts.filter((context) => unsupportedGlob.test(context)))];
  if (unsupported.length)
    return [
      ...checks,
      ...unsupported.map((name) => ({
        name,
        status: "pending" as const,
        description: "Required check pattern cannot be evaluated.",
        url: null,
      })),
    ];
  const patterns = [...new Set(contexts)];
  return [
    ...checks.map((check) =>
      patterns.some((pattern) => matchesContext(pattern, check.name))
        ? { ...check, required: true }
        : check,
    ),
    ...patterns.flatMap((name) =>
      !name.trim() || checks.some((check) => matchesContext(name, check.name))
        ? []
        : [{ name, status: "pending" as const, description: null, url: null, required: true }],
    ),
  ];
}
