/**
 * Upstream topic classification and scoring, shared by triage, the list view
 * and the web page. Classification facts (`kind`, `severity`, `f5Coverage`)
 * are stored on the ledger suggestion; lane and score are always derived, so
 * tuning the weights here never rewrites the ledger.
 *
 * @module upstreamPortsScore
 */
import type {
  UpstreamAreaDefinition,
  UpstreamChangeKind,
  UpstreamF5Coverage,
  UpstreamLane,
  UpstreamSecuritySeverity,
  UpstreamSuggestionStatus,
  UpstreamUserImpact,
} from "@t3tools/contracts";

import { isLockfilePath, normalizeArea as squash } from "./upstreamPortsGrouping";

/** Mirrors `UpstreamAreaPolicy` in `@t3tools/contracts` (wire settings). */
export type AreaPolicy = "follow" | "fixes-only" | "ignore";

// ── Change kind ─────────────────────────────────────────────────────────

const CONVENTIONAL_PATTERN = /^([a-z]+)(?:\([^)]*\))?!?:/iu;
const REVERT_SUBJECT_PATTERN = /^revert\b/iu;

const PREFIX_KINDS: Readonly<Record<string, UpstreamChangeKind>> = {
  fix: "fix",
  feat: "feat",
  perf: "perf",
  refactor: "refactor",
  revert: "revert",
  chore: "maintenance",
  test: "maintenance",
  tests: "maintenance",
  docs: "maintenance",
  ci: "maintenance",
  build: "maintenance",
  style: "maintenance",
};

const SUBJECT_SECURITY_PATTERNS = [
  /\bCVE-\d{4}-\d{4,}\b/iu,
  /\bGHSA(?:-[0-9a-z]{4}){3}\b/iu,
  /\bvulnerabilit(?:y|ies)\b/iu,
  /\bsecurity (?:fix|fixes|patch|patches|update|updates|advisory|advisories|issue|issues|hardening)\b/iu,
];
const BODY_SECURITY_PATTERNS = [
  /\bCVE-\d{4}-\d{4,}\b/iu,
  /\bGHSA(?:-[0-9a-z]{4}){3}\b/iu,
  /\bsecurity (?:vulnerability|advisory|advisories)\b/iu,
];

/** The kind a conventional-commit subject names, or `null` without a known prefix. */
export function kindFromSubject(subject: string): UpstreamChangeKind | null {
  if (REVERT_SUBJECT_PATTERN.test(subject) && !CONVENTIONAL_PATTERN.test(subject)) return "revert";
  const match = CONVENTIONAL_PATTERN.exec(subject);
  if (!match) return null;
  return PREFIX_KINDS[match[1]!.toLowerCase()] ?? null;
}

/** CVE or GHSA ids, vulnerabilities, or a named security fix, patch or advisory. */
export function hasSecurityHint(subject: string, body: string | null = null): boolean {
  if (SUBJECT_SECURITY_PATTERNS.some((pattern) => pattern.test(subject))) return true;
  return body !== null && BODY_SECURITY_PATTERNS.some((pattern) => pattern.test(body));
}

const KIND_PRECEDENCE: ReadonlyArray<UpstreamChangeKind> = [
  "security",
  "fix",
  "revert",
  "feat",
  "perf",
  "refactor",
  "maintenance",
];

/**
 * A topic's kind from its commits: security when any commit carries a security
 * hint, otherwise the highest-precedence prefix. Subjects without a known
 * prefix count as `fix` so an unconventional change is never buried.
 */
export function topicKindFromCommits(
  commits: ReadonlyArray<{ readonly subject: string; readonly body?: string | null }>,
): UpstreamChangeKind {
  const kinds = new Set<UpstreamChangeKind>();
  for (const commit of commits) {
    if (hasSecurityHint(commit.subject, commit.body ?? null)) return "security";
    kinds.add(kindFromSubject(commit.subject) ?? "fix");
  }
  return KIND_PRECEDENCE.find((kind) => kinds.has(kind)) ?? "fix";
}

const KINDS = new Set<string>(KIND_PRECEDENCE);
const SEVERITIES = new Set<string>(["critical", "high", "medium", "low"]);

export function asChangeKind(value: string | null | undefined): UpstreamChangeKind | null {
  return value != null && KINDS.has(value) ? (value as UpstreamChangeKind) : null;
}

export function asSecuritySeverity(
  value: string | null | undefined,
): UpstreamSecuritySeverity | null {
  return value != null && SEVERITIES.has(value) ? (value as UpstreamSecuritySeverity) : null;
}

// ── Coverage ────────────────────────────────────────────────────────────

/** Tests, docs, snapshots and lockfiles say nothing about whether f5 has the code. */
export function isCoverageExcludedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    isLockfilePath(path) ||
    name.endsWith(".lock") ||
    name.endsWith(".snap") ||
    name.endsWith(".md") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name) ||
    name.endsWith(".browser.tsx") ||
    path.startsWith("docs/") ||
    /(?:^|\/)(?:__tests__|__snapshots__|test|tests)\//u.test(path)
  );
}

/** `null` when no source path remains (or none is known). */
export function coverageOf(
  files: ReadonlyArray<{ readonly path: string; readonly existsInFork: boolean }>,
): UpstreamF5Coverage | null {
  const source = files.filter((file) => !isCoverageExcludedPath(file.path));
  if (source.length === 0) return null;
  const present = source.filter((file) => file.existsInFork).length;
  return present === source.length ? "all" : present === 0 ? "none" : "partial";
}

/** Combines per-commit coverage into the topic's. */
export function combineCoverage(
  values: ReadonlyArray<UpstreamF5Coverage | null | undefined>,
): UpstreamF5Coverage | null {
  const known = values.filter((value): value is UpstreamF5Coverage => value != null);
  if (known.length === 0) return null;
  if (known.every((value) => value === "all")) return "all";
  if (known.every((value) => value === "none")) return "none";
  return "partial";
}

// ── Areas ───────────────────────────────────────────────────────────────

export type AreaAliasMap = ReadonlyMap<string, string>;

/** Lowercased name (and its hyphenated form) to the taxonomy key. */
export function buildAreaAliasMap(
  areas: ReadonlyArray<UpstreamAreaDefinition> | undefined,
): AreaAliasMap {
  const out = new Map<string, string>();
  for (const area of areas ?? [])
    for (const name of [area.key, ...area.aliases]) {
      out.set(name.trim().toLowerCase(), area.key);
      out.set(squash(name), area.key);
    }
  return out;
}

/** Lowercase, spaces to hyphens, then the alias map; unknown areas keep the squashed form. */
export function normalizeArea(area: string, aliases: AreaAliasMap): string {
  const lower = area.trim().toLowerCase();
  return aliases.get(lower) ?? aliases.get(squash(area)) ?? squash(area);
}

/** Normalized, de-duplicated, order kept, empty names dropped. */
export function normalizeAreas(areas: ReadonlyArray<string>, aliases: AreaAliasMap): string[] {
  const out: string[] = [];
  for (const area of areas) {
    const normalized = normalizeArea(area, aliases);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * A feature's policy: `follow` when any of its areas is followed, `ignore`
 * when it has areas and all are ignored, otherwise `fixes-only`.
 */
export function featureAreaPolicy(
  areas: ReadonlyArray<string>,
  areaPolicy: Readonly<Record<string, AreaPolicy>>,
): AreaPolicy {
  const squashed = areas.map(squash);
  if (squashed.some((area) => areaPolicy[area] === "follow")) return "follow";
  if (squashed.length > 0 && squashed.every((area) => areaPolicy[area] === "ignore"))
    return "ignore";
  return "fixes-only";
}

// ── Lane and score ──────────────────────────────────────────────────────

export function laneOfKind(kind: UpstreamChangeKind): UpstreamLane {
  switch (kind) {
    case "security":
      return "security";
    case "fix":
    case "revert":
      return "bug";
    case "perf":
      return "perf";
    case "feat":
      return "feature";
    case "refactor":
    case "maintenance":
      return "maintenance";
  }
}

/** v1 weights; one table so they can be tuned without API changes. */
export const UPSTREAM_SCORE_WEIGHTS = {
  security: { critical: 100, high: 90, medium: 75, low: 55 },
  bug: 40,
  perf: 35,
  feature: { follow: 40, "fixes-only": 15, ignore: 0 },
  maintenance: 5,
  impact: { high: 30, medium: 15, low: 0, none: -15 },
  coverage: { all: 15, partial: 5, none: -20 },
  suggestion: { skip: -30, watch: -10 },
} as const;

export interface ScoreInput {
  readonly kind: UpstreamChangeKind;
  /** Security topics without a severity score as `low`. */
  readonly severity?: UpstreamSecuritySeverity | null | undefined;
  readonly impact?: UpstreamUserImpact | null | undefined;
  readonly coverage?: UpstreamF5Coverage | null | undefined;
  readonly suggestionStatus?: UpstreamSuggestionStatus | null | undefined;
  /** Feature lane only. */
  readonly featurePolicy?: AreaPolicy | undefined;
}

export interface ScorePart {
  readonly label: string;
  readonly delta: number;
}

export interface ScoreResult {
  readonly lane: UpstreamLane;
  readonly score: number;
  /** The base first, then each non-zero adjustment. */
  readonly parts: ReadonlyArray<ScorePart>;
}

const LANE_LABELS: Readonly<Record<UpstreamLane, string>> = {
  security: "Security",
  bug: "Bug",
  perf: "Perf",
  feature: "Feature",
  maintenance: "Maintenance",
};

export const laneLabel = (lane: UpstreamLane) => LANE_LABELS[lane];

export function scoreUpstreamTopic(input: ScoreInput): ScoreResult {
  const weights = UPSTREAM_SCORE_WEIGHTS;
  const lane = laneOfKind(input.kind);
  const parts: ScorePart[] = [];
  switch (lane) {
    case "security": {
      const severity = input.severity ?? "low";
      parts.push({ label: `Security (${severity})`, delta: weights.security[severity] });
      break;
    }
    case "feature": {
      const policy = input.featurePolicy ?? "fixes-only";
      const label =
        policy === "follow"
          ? "followed area"
          : policy === "ignore"
            ? "ignored area"
            : "area not followed";
      parts.push({ label: `Feature (${label})`, delta: weights.feature[policy] });
      break;
    }
    case "bug":
    case "perf":
    case "maintenance":
      parts.push({ label: LANE_LABELS[lane], delta: weights[lane] });
      break;
  }
  const add = (label: string, delta: number) => {
    if (delta !== 0) parts.push({ label, delta });
  };
  if (input.impact) add(`${input.impact} impact`, weights.impact[input.impact]);
  if (input.coverage) {
    const label =
      input.coverage === "all"
        ? "files exist in f5"
        : input.coverage === "partial"
          ? "some files exist in f5"
          : "files missing in f5";
    add(label, weights.coverage[input.coverage]);
  }
  if (input.suggestionStatus === "skip" || input.suggestionStatus === "watch")
    add(`suggested ${input.suggestionStatus}`, weights.suggestion[input.suggestionStatus]);
  const raw = parts.reduce((sum, part) => sum + part.delta, 0);
  return { lane, score: Math.max(0, Math.min(100, raw)), parts };
}

/** `Bug 40 · high impact +30 · files exist in f5 +15`. */
export function formatScoreParts(parts: ReadonlyArray<ScorePart>): string {
  return parts
    .map((part, index) =>
      index === 0
        ? `${part.label} ${part.delta}`
        : `${part.label} ${part.delta > 0 ? "+" : "−"}${Math.abs(part.delta)}`,
    )
    .join(" · ");
}
