import {
  UPSTREAM_SUGGESTION_REASON_MAX,
  type UpstreamDecision,
  type UpstreamPortOutcome,
} from "@t3tools/contracts";

const OUTCOME_PATTERN =
  /^UPSTREAM-OUTCOME(?: (pr-[1-9][0-9]*(?:-[0-9a-f]{7})?|c-[0-9a-f]{12}))?: (pr|equivalent|not-applicable|blocked) (.+)$/u;

export interface ParsedUpstreamOutcomes {
  readonly thread: UpstreamPortOutcome | null;
  readonly byTopic: ReadonlyMap<string, UpstreamPortOutcome>;
  /** Scope is a topic id, or "thread". Invalid scopes never fall back to a thread outcome. */
  readonly errors: ReadonlyMap<string, string>;
}

function validEvidence(entry: string): boolean {
  const match = /^(.+):([1-9][0-9]*)$/u.exec(entry);
  if (!match) return false;
  const file = match[1]!;
  return (
    !/[\s:\\]/u.test(file) &&
    !file.startsWith("/") &&
    file.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function githubRepo(value: string): string | null {
  const scp = /^[^/@]+@([^/:]+):(.+)$/u.exec(value);
  const input = scp
    ? `ssh://${scp[1]}/${scp[2]}`
    : /^[^/:]+\/[^/]+$/u.test(value)
      ? `https://github.com/${value}`
      : value;
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    const repo = url.pathname
      .replace(/\/$/u, "")
      .replace(/\.git$/u, "")
      .replace(/^\//u, "");
    return host === "github.com" && /^[^/]+\/[^/]+$/u.test(repo) ? repo.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function parseUpstreamOutcomes(
  text: string,
  options: { readonly forkRepo?: string | null } = {},
): ParsedUpstreamOutcomes {
  const values = new Map<string, UpstreamPortOutcome>();
  const errors = new Map<string, string>();
  const lines = text.replaceAll("\r\n", "\n").trimEnd().split("\n");
  let start = lines.length;
  while (start > 0 && lines[start - 1]!.startsWith("UPSTREAM-OUTCOME")) start--;
  for (const line of lines.slice(start)) {
    const match = OUTCOME_PATTERN.exec(line);
    const scope = match?.[1] ?? /^UPSTREAM-OUTCOME ([^:]+):/u.exec(line)?.[1] ?? "thread";
    if (!match) {
      errors.set(scope, "Invalid outcome syntax.");
      continue;
    }
    const outcome = { kind: match[2] as UpstreamPortOutcome["kind"], detail: match[3]!.trim() };
    let valid = outcome.detail.length > 0;
    if (outcome.kind === "pr") {
      const pr = /^https:\/\/github\.com\/([^/?#]+\/[^/?#]+)\/pull\/([1-9][0-9]*)$/u.exec(
        outcome.detail,
      );
      const repo = options.forkRepo ? githubRepo(options.forkRepo) : null;
      valid =
        !!pr &&
        (options.forkRepo === undefined || (repo !== null && pr[1]!.toLowerCase() === repo));
    } else if (outcome.kind === "equivalent") {
      valid = outcome.detail.split(",").every((entry) => validEvidence(entry.trim()));
    } else valid &&= outcome.detail.length <= 1_000;
    if (!valid) {
      errors.set(scope, "Invalid outcome detail.");
      continue;
    }
    const previous = values.get(scope);
    if (previous && (previous.kind !== outcome.kind || previous.detail !== outcome.detail))
      errors.set(scope, "Conflicting outcomes for the same scope.");
    else values.set(scope, outcome);
  }
  for (const scope of errors.keys()) values.delete(scope);
  const thread = values.get("thread") ?? null;
  values.delete("thread");
  return { thread, byTopic: values, errors };
}

export function parseUpstreamOutcome(text: string): UpstreamPortOutcome | null {
  return parseUpstreamOutcomes(text).thread;
}

export function outcomeForTopic(
  parsed: ParsedUpstreamOutcomes,
  topicId: string,
  topicCount = 1,
): UpstreamPortOutcome | null {
  if (parsed.errors.has(topicId)) return null;
  const scoped = parsed.byTopic.get(topicId);
  if (scoped) return scoped;
  // A batch's PR/blocked result describes the thread; a decision must name its topic.
  if (
    topicCount > 1 &&
    (parsed.thread?.kind === "equivalent" || parsed.thread?.kind === "not-applicable")
  )
    return null;
  return parsed.thread;
}

/** Display compatibility only for ports excluded from automatic outcome recording. */
export function parseLegacyUpstreamOutcomes(
  text: string,
  options: { readonly forkRepo?: string | null } = {},
): ParsedUpstreamOutcomes {
  const parsed = parseUpstreamOutcomes(text, options);
  if (parsed.thread || parsed.byTopic.size || parsed.errors.size) return parsed;
  const line = text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .findLast((line) => line.startsWith("UPSTREAM-OUTCOME: "));
  return line ? parseUpstreamOutcomes(line, options) : parsed;
}

/** `path:line` items from an equivalent outcome. */
export function outcomeEvidence(outcome: UpstreamPortOutcome): string[] {
  return outcome.detail
    .split(",")
    .map((entry) => entry.trim())
    .filter(validEvidence);
}

export function decisionFromOutcome(
  outcome: UpstreamPortOutcome | null,
  prNumber: number | null,
): UpstreamDecision | null {
  if (outcome?.kind === "equivalent") {
    const evidence = outcomeEvidence(outcome);
    if (!evidence.length || evidence.length !== outcome.detail.split(",").length) return null;
    return { kind: "equivalent", ...(prNumber ? { f5Refs: [`#${prNumber}`] } : {}), evidence };
  }
  if (outcome?.kind === "not-applicable" && outcome.detail.trim())
    return {
      kind: "skip",
      reasonKey: "not-applicable",
      reason: outcome.detail.slice(0, UPSTREAM_SUGGESTION_REASON_MAX),
    };
  return null;
}
