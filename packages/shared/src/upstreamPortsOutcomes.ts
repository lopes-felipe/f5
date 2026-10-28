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
      const repo = options.forkRepo
        ?.replace(/^https:\/\/github\.com\//u, "")
        .replace(/^git@github\.com:/u, "")
        .replace(/^ssh:\/\/git@github\.com\//u, "")
        .replace(/\.git$/u, "")
        .replace(/\/$/u, "");
      valid =
        !!pr && options.forkRepo !== null && (!repo || pr[1]!.toLowerCase() === repo.toLowerCase());
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
): UpstreamPortOutcome | null {
  if (parsed.errors.has(topicId)) return null;
  return parsed.byTopic.get(topicId) ?? parsed.thread;
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
