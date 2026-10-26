/**
 * Upstream ledger v7: pure parsing, validation, derived state, and operation
 * replay shared by the CI checker, the migration script, and the F5 server.
 *
 * Ledger-state files (`intervals/`, `legacy/`, `topics/`) are written only by
 * F5 through `canonicalJson`, so byte equality is content equality.
 */
import { createHash } from "node:crypto";

import {
  UPSTREAM_LEDGER_SCHEMA_VERSION,
  UPSTREAM_POLICY_MAX_BYTES,
  UPSTREAM_SUGGESTION_AREAS_MAX,
  UPSTREAM_SUGGESTION_QUESTION_MAX,
  UPSTREAM_SUGGESTION_REASON_MAX,
  UPSTREAM_TOPIC_SCOPE_MAX,
  UPSTREAM_TOPIC_SUMMARY_MAX,
  UPSTREAM_TOPIC_TITLE_MAX,
  UpstreamIntervalFile,
  UpstreamLegacyBatchFile,
  UpstreamRules,
  UpstreamTopicFile,
  type UpstreamMembershipCommit,
  type UpstreamTopic,
  type UpstreamTopicState,
  type UpstreamTopicStatus,
} from "@t3tools/contracts";
import { Exit, Schema } from "effect";

export type IntervalFile = typeof UpstreamIntervalFile.Type;
export type LegacyBatchFile = typeof UpstreamLegacyBatchFile.Type;
export type TopicFile = typeof UpstreamTopicFile.Type;
export type Rules = typeof UpstreamRules.Type;

export const SHA_PATTERN = /^[0-9a-f]{40}$/u;
export const LEDGER_STATE_DIRS = ["intervals", "legacy", "topics"] as const;
export const IMMUTABLE_LEDGER_DIRS = ["intervals", "legacy", "archive"] as const;
export const ARCHIVE_PATH = "archive/schema6.json";
export const RULES_PATH = "rules.json";
export const POLICY_PATH = "policy.md";

// ── Canonical serialization ─────────────────────────────────────────────

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

/** Recursively sorted keys, absent optionals omitted, 2-space indent, trailing LF. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Schema-6 convention: SHA-256 over the SHAs, LF-joined with a final LF. */
export function digestShas(shas: ReadonlyArray<string>): string {
  return sha256Hex(`${shas.join("\n")}\n`);
}

// ── File paths ──────────────────────────────────────────────────────────

const pad4 = (value: number) => String(value).padStart(4, "0");

export function intervalPath(file: Pick<IntervalFile, "interval" | "targetSha">): string {
  return `intervals/${pad4(file.interval)}-${file.targetSha.slice(0, 12)}.json`;
}

export function legacyPath(file: Pick<LegacyBatchFile, "batch">): string {
  return `legacy/${pad4(file.batch)}.json`;
}

export function topicMonthPath(month: string): string {
  return `topics/${month}.json`;
}

export function monthOf(isoDateTime: string): string {
  return isoDateTime.slice(0, 7);
}

export function isLedgerStatePath(relativePath: string): boolean {
  return LEDGER_STATE_DIRS.some((dir) => relativePath.startsWith(`${dir}/`));
}

// ── Parsing ─────────────────────────────────────────────────────────────

export interface UpstreamLedger {
  readonly intervals: ReadonlyArray<IntervalFile>;
  readonly legacy: ReadonlyArray<LegacyBatchFile>;
  readonly topics: ReadonlyArray<UpstreamTopic>;
}

export const EMPTY_LEDGER: UpstreamLedger = { intervals: [], legacy: [], topics: [] };

export interface ParsedLedger {
  readonly ledger: UpstreamLedger;
  readonly errors: ReadonlyArray<string>;
  /** Paths that failed to decode; their content is missing from `ledger`. */
  readonly unparsed: ReadonlyArray<string>;
}

function formatDecodeError(error: unknown): string {
  return String(error).split("\n").slice(0, 6).join(" ").slice(0, 600);
}

function decodeFile<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  relativePath: string,
  text: string,
  errors: string[],
): S["Type"] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    errors.push(`${relativePath}: invalid JSON (${String(error)})`);
    return null;
  }
  const decoded = Schema.decodeUnknownExit(schema)(raw, { onExcessProperty: "error" });
  if (Exit.isFailure(decoded)) {
    errors.push(`${relativePath}: ${formatDecodeError(decoded.cause)}`);
    return null;
  }
  if (canonicalJson(decoded.value) !== text) {
    errors.push(`${relativePath}: not canonical JSON; ledger files are written only by F5`);
  }
  return decoded.value;
}

/**
 * Parse ledger-state files keyed by path relative to the ledger directory.
 * Files outside `intervals/`, `legacy/`, and `topics/` are ignored.
 */
export function parseLedgerFiles(files: ReadonlyMap<string, string>): ParsedLedger {
  const errors: string[] = [];
  const unparsed: string[] = [];
  const intervals: IntervalFile[] = [];
  const legacy: LegacyBatchFile[] = [];
  const topics: UpstreamTopic[] = [];
  for (const [relativePath, text] of [...files.entries()].toSorted(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (relativePath.startsWith("intervals/")) {
      const file = decodeFile(UpstreamIntervalFile, relativePath, text, errors);
      if (!file) {
        unparsed.push(relativePath);
        continue;
      }
      if (intervalPath(file) !== relativePath)
        errors.push(`${relativePath}: file name must be ${intervalPath(file)}`);
      intervals.push(file);
    } else if (relativePath.startsWith("legacy/")) {
      const file = decodeFile(UpstreamLegacyBatchFile, relativePath, text, errors);
      if (!file) {
        unparsed.push(relativePath);
        continue;
      }
      if (legacyPath(file) !== relativePath)
        errors.push(`${relativePath}: file name must be ${legacyPath(file)}`);
      legacy.push(file);
    } else if (relativePath.startsWith("topics/")) {
      const file = decodeFile(UpstreamTopicFile, relativePath, text, errors);
      if (!file) {
        unparsed.push(relativePath);
        continue;
      }
      if (topicMonthPath(file.month) !== relativePath)
        errors.push(`${relativePath}: file name must be ${topicMonthPath(file.month)}`);
      const ids = file.topics.map((topic) => topic.id);
      if (JSON.stringify(ids) !== JSON.stringify(ids.toSorted()))
        errors.push(`${relativePath}: topics must be sorted by id`);
      for (const topic of file.topics) {
        if (monthOf(topic.createdAt) !== file.month)
          errors.push(`${relativePath}: topic ${topic.id} createdAt is outside ${file.month}`);
        topics.push(topic);
      }
    }
  }
  return {
    ledger: {
      intervals: intervals.toSorted((a, b) => a.interval - b.interval),
      legacy: legacy.toSorted((a, b) => a.batch - b.batch),
      topics: topics.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
    errors,
    unparsed,
  };
}

export function serializeTopicFiles(topics: ReadonlyArray<UpstreamTopic>): Map<string, string> {
  const byMonth = new Map<string, UpstreamTopic[]>();
  for (const topic of topics) {
    const month = monthOf(topic.createdAt);
    byMonth.set(month, [...(byMonth.get(month) ?? []), topic]);
  }
  const out = new Map<string, string>();
  for (const [month, monthTopics] of byMonth) {
    out.set(
      topicMonthPath(month),
      canonicalJson({
        schemaVersion: UPSTREAM_LEDGER_SCHEMA_VERSION,
        month,
        topics: monthTopics.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      } satisfies TopicFile),
    );
  }
  return out;
}

/** Every ledger-state file the ledger implies, keyed by path relative to the ledger dir. */
export function serializeLedgerFiles(ledger: UpstreamLedger): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of ledger.intervals) out.set(intervalPath(file), canonicalJson(file));
  for (const file of ledger.legacy) out.set(legacyPath(file), canonicalJson(file));
  for (const [path, text] of serializeTopicFiles(ledger.topics)) out.set(path, text);
  return out;
}

// ── Rules and policy ────────────────────────────────────────────────────

export interface ParsedRules {
  readonly rules: Rules | null;
  readonly errors: ReadonlyArray<string>;
}

export function parseRules(text: string): ParsedRules {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { rules: null, errors: [`${RULES_PATH}: invalid JSON (${String(error)})`] };
  }
  const decoded = Schema.decodeUnknownExit(UpstreamRules)(raw, { onExcessProperty: "error" });
  if (Exit.isFailure(decoded))
    return { rules: null, errors: [`${RULES_PATH}: ${formatDecodeError(decoded.cause)}`] };
  const rules = decoded.value;
  const keys = new Set(rules.reasonKeys);
  if (keys.size !== rules.reasonKeys.length) errors.push(`${RULES_PATH}: duplicate reason key`);
  for (const key of rules.reasonKeys) {
    if (!/^[a-z0-9-]+$/u.test(key)) errors.push(`${RULES_PATH}: invalid reason key ${key}`);
    if (!rules.reasonLabels[key]?.trim())
      errors.push(`${RULES_PATH}: reason key ${key} has no label`);
  }
  for (const slug of rules.upstreamOnlySubsystems)
    if (!/^[a-z0-9-]+$/u.test(slug)) errors.push(`${RULES_PATH}: invalid subsystem slug ${slug}`);
  for (const rule of rules.autoSkip) {
    if (!keys.has(rule.reasonKey))
      errors.push(`${RULES_PATH}: autoSkip rule uses unknown reason key ${rule.reasonKey}`);
    if (!rule.pathPrefixes?.length && !rule.pathSuffixes?.length)
      errors.push(`${RULES_PATH}: autoSkip rule ${rule.reasonKey} matches no paths`);
  }
  // matchAutoSkipRule reports commits that touch only ignored paths as maintenance.
  if (rules.ignoredPathPrefixes.length > 0 && !keys.has("maintenance"))
    errors.push(
      `${RULES_PATH}: reasonKeys must include maintenance when ignoredPathPrefixes is set`,
    );
  if (!(rules.autoSkipConfidence >= 0 && rules.autoSkipConfidence <= 1))
    errors.push(`${RULES_PATH}: autoSkipConfidence must be between 0 and 1`);
  return { rules, errors };
}

export function validatePolicy(text: string): string[] {
  return Buffer.byteLength(text, "utf8") > UPSTREAM_POLICY_MAX_BYTES
    ? [`${POLICY_PATH}: exceeds ${UPSTREAM_POLICY_MAX_BYTES} bytes`]
    : [];
}

export function isValidReasonKey(rules: Rules, key: string): boolean {
  if (rules.reasonKeys.includes(key)) return true;
  const match = /^upstream-only:([a-z0-9-]+)$/u.exec(key);
  return match !== null && rules.upstreamOnlySubsystems.includes(match[1]!);
}

export function reasonLabel(rules: Rules, key: string): string {
  const label = rules.reasonLabels[key];
  if (label) return label;
  const match = /^upstream-only:([a-z0-9-]+)$/u.exec(key);
  return match ? `Upstream-only subsystem: ${match[1]}` : key;
}

/**
 * A commit with zero changed files never matches. Files under ignored prefixes
 * are dropped; if nothing remains the commit is maintenance. Otherwise a rule
 * matches only when every remaining file matches one of its prefixes or suffixes.
 */
export function matchAutoSkipRule(files: ReadonlyArray<string>, rules: Rules): string | null {
  if (files.length === 0) return null;
  const remaining = files.filter(
    (file) => !rules.ignoredPathPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  if (remaining.length === 0) return "maintenance";
  for (const rule of rules.autoSkip) {
    const matches = (file: string) =>
      (rule.pathPrefixes ?? []).some((prefix) => file.startsWith(prefix)) ||
      (rule.pathSuffixes ?? []).some((suffix) => file.endsWith(suffix));
    if (remaining.every(matches)) return rule.reasonKey;
  }
  return null;
}

// ── Validation ──────────────────────────────────────────────────────────

export interface ArchiveContext {
  /** Last pinned target of the schema-6 archive; interval 1 starts here. */
  readonly lastTargetSha: string;
  /** Archive `deferred` records by SHA, with their subjects. */
  readonly deferredSubjects: ReadonlyMap<string, string>;
}

const nonEmpty = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

const EVIDENCE_PATTERN = /^([^:]+):([1-9][0-9]*)$/u;
export function hasValidEvidenceShape(value: string): boolean {
  const match = EVIDENCE_PATTERN.exec(value);
  if (!match) return false;
  const file = match[1]!.replaceAll("\\", "/");
  return !file.startsWith("/") && !/^[a-z]:/iu.test(file) && !file.split("/").includes("..");
}

export function isValidF5Ref(value: string): boolean {
  return SHA_PATTERN.test(value) || /^#[1-9][0-9]*$/u.test(value);
}

export function validateTopic(topic: UpstreamTopic, rules: Rules | null): string[] {
  const errors: string[] = [];
  const owner = `topic ${topic.id}`;
  const status = topic.status;
  if (!nonEmpty(topic.title) || topic.title.length > UPSTREAM_TOPIC_TITLE_MAX)
    errors.push(`${owner}: title must be 1-${UPSTREAM_TOPIC_TITLE_MAX} characters`);
  if (topic.summary.length > UPSTREAM_TOPIC_SUMMARY_MAX)
    errors.push(`${owner}: summary exceeds ${UPSTREAM_TOPIC_SUMMARY_MAX} characters`);
  if (topic.epoch < 1) errors.push(`${owner}: epoch must be at least 1`);
  if (status === "skip") {
    if (!topic.reasonKey) errors.push(`${owner}: skip requires reasonKey`);
    else if (rules && !isValidReasonKey(rules, topic.reasonKey))
      errors.push(`${owner}: unknown reasonKey ${topic.reasonKey}`);
  } else if (topic.reasonKey !== undefined) {
    errors.push(`${owner}: reasonKey is allowed only with skip`);
  }
  if (
    (status === "skip" || status === "declined" || status === "watch" || status === "equivalent") &&
    !nonEmpty(topic.reason)
  )
    errors.push(`${owner}: ${status} requires a reason`);
  if (topic.scope !== undefined) {
    if (status !== "port") errors.push(`${owner}: scope is allowed only with port`);
    if (topic.scope.length > UPSTREAM_TOPIC_SCOPE_MAX)
      errors.push(`${owner}: scope exceeds ${UPSTREAM_TOPIC_SCOPE_MAX} characters`);
  }
  if (status !== "inbox" && (topic.decidedBy === undefined || topic.decidedAt === undefined))
    errors.push(`${owner}: ${status} requires decidedBy and decidedAt`);
  if ((topic.decidedBy === undefined) !== (topic.decidedAt === undefined))
    errors.push(`${owner}: decidedBy and decidedAt must be set together`);
  if (status === "watch" && topic.revisitAfter === undefined)
    errors.push(`${owner}: watch requires revisitAfter`);
  if (status !== "watch" && topic.revisitAfter !== undefined)
    errors.push(`${owner}: revisitAfter is allowed only with watch`);
  if (status === "equivalent") {
    if (!topic.equivalence) errors.push(`${owner}: equivalent requires equivalence`);
    else {
      if (topic.equivalence.f5Refs.length === 0)
        errors.push(`${owner}: equivalence needs at least one f5 ref`);
      for (const ref of topic.equivalence.f5Refs)
        if (!isValidF5Ref(ref)) errors.push(`${owner}: invalid f5 ref ${ref}`);
      for (const evidence of topic.equivalence.evidence)
        if (!hasValidEvidenceShape(evidence))
          errors.push(`${owner}: evidence must be a relative path:line, got ${evidence}`);
    }
  } else if (topic.equivalence !== undefined) {
    errors.push(`${owner}: equivalence is allowed only with equivalent`);
  }
  const suggestion = topic.suggestion;
  if (suggestion) {
    if (suggestion.reason.length > UPSTREAM_SUGGESTION_REASON_MAX)
      errors.push(`${owner}: suggestion reason exceeds ${UPSTREAM_SUGGESTION_REASON_MAX}`);
    if (suggestion.areas.length > UPSTREAM_SUGGESTION_AREAS_MAX)
      errors.push(`${owner}: suggestion has more than ${UPSTREAM_SUGGESTION_AREAS_MAX} areas`);
    if ((suggestion.question?.length ?? 0) > UPSTREAM_SUGGESTION_QUESTION_MAX)
      errors.push(`${owner}: suggestion question exceeds ${UPSTREAM_SUGGESTION_QUESTION_MAX}`);
    if (!(suggestion.confidence >= 0 && suggestion.confidence <= 1))
      errors.push(`${owner}: suggestion confidence must be between 0 and 1`);
    if (suggestion.f5Refs !== undefined && suggestion.status !== "equivalent")
      errors.push(`${owner}: suggestion f5Refs are allowed only with equivalent`);
  }
  return errors;
}

export interface ValidateLedgerOptions {
  readonly rules: Rules | null;
  /** When present, interval 1 must start at the archive target and legacy members must be deferred. */
  readonly archive?: ArchiveContext | null;
}

export function validateLedger(ledger: UpstreamLedger, options: ValidateLedgerOptions): string[] {
  const errors: string[] = [];
  const archive = options.archive ?? null;

  let previousTarget = archive?.lastTargetSha;
  ledger.intervals.forEach((file, index) => {
    const owner = `interval ${file.interval}`;
    if (file.interval !== index + 1) errors.push(`intervals must be contiguous from 1 (${owner})`);
    if (previousTarget !== undefined && file.baseSha !== previousTarget)
      errors.push(
        index === 0
          ? `${owner}: baseSha must equal the archive's last targetSha ${previousTarget}`
          : `${owner}: baseSha must equal interval ${index}'s targetSha`,
      );
    if (file.count !== file.commits.length || file.count === 0)
      errors.push(`${owner}: count differs from its commits`);
    if (file.commits[0]?.sha !== file.targetSha)
      errors.push(`${owner}: first commit must be the targetSha`);
    if (file.digest !== digestShas(file.commits.map((commit) => commit.sha)))
      errors.push(`${owner}: digest differs from its commits`);
    previousTarget = file.targetSha;
  });

  ledger.legacy.forEach((file, index) => {
    const owner = `legacy batch ${file.batch}`;
    if (file.batch !== index + 1)
      errors.push(`legacy batches must be contiguous from 1 (${owner})`);
    if (file.count !== file.commits.length || file.count === 0)
      errors.push(`${owner}: count differs from its commits`);
    if (file.digest !== digestShas(file.commits.map((commit) => commit.sha).toSorted()))
      errors.push(`${owner}: digest differs from its sorted commits`);
    if (archive)
      for (const commit of file.commits) {
        const subject = archive.deferredSubjects.get(commit.sha);
        if (subject === undefined)
          errors.push(`${owner}: ${commit.sha} is not an archive deferred record`);
        else if (subject !== commit.subject)
          errors.push(`${owner}: subject differs from the archive for ${commit.sha}`);
      }
  });

  const topicIds = new Map<string, UpstreamTopic>();
  for (const topic of ledger.topics) {
    if (topicIds.has(topic.id)) errors.push(`duplicate topic id ${topic.id}`);
    topicIds.set(topic.id, topic);
  }
  const seen = new Map<string, string>();
  const members = new Map<string, number>();
  const visit = (commit: UpstreamMembershipCommit, owner: string) => {
    const previous = seen.get(commit.sha);
    if (previous !== undefined)
      errors.push(`${commit.sha} appears in both ${previous} and ${owner}`);
    seen.set(commit.sha, owner);
    if (!topicIds.has(commit.topic))
      errors.push(`${owner}: ${commit.sha} references unknown topic ${commit.topic}`);
    members.set(commit.topic, (members.get(commit.topic) ?? 0) + 1);
  };
  for (const file of ledger.intervals)
    for (const commit of file.commits) visit(commit, `interval ${file.interval}`);
  for (const file of ledger.legacy)
    for (const commit of file.commits) visit(commit, `legacy batch ${file.batch}`);

  for (const topic of ledger.topics) {
    if (!members.has(topic.id)) errors.push(`topic ${topic.id} has no member commits`);
    errors.push(...validateTopic(topic, options.rules));
    for (const related of topic.relatedTopics ?? [])
      if (!topicIds.has(related))
        errors.push(`topic ${topic.id}: related topic ${related} does not exist`);
  }
  return errors;
}

// ── Provenance (synchronous git, used by the CLI checker) ───────────────

export type RunGitSync = (args: ReadonlyArray<string>) => string;

/** Each interval equals its first-parent slice of `remoteRef`, with matching subjects. */
export function validateProvenance(
  intervals: ReadonlyArray<IntervalFile>,
  runGit: RunGitSync,
  remoteRef: string,
): string[] {
  if (intervals.length === 0) return [];
  const errors: string[] = [];
  const ancestry = new Set(
    runGit(["rev-list", "--first-parent", remoteRef]).split("\n").filter(Boolean),
  );
  for (const file of intervals) {
    const owner = `interval ${file.interval}`;
    if (!ancestry.has(file.targetSha)) {
      errors.push(`${owner}: targetSha is not on ${remoteRef} first-parent history`);
      continue;
    }
    const lines = runGit([
      "log",
      "--first-parent",
      "--format=%H%x1f%s",
      `${file.baseSha}..${file.targetSha}`,
    ])
      .split("\n")
      .filter(Boolean);
    const actual = lines.map((line) => {
      const [sha, subject] = line.split("\x1f");
      return { sha: sha!, subject: subject ?? "" };
    });
    if (
      JSON.stringify(actual.map((commit) => commit.sha)) !==
      JSON.stringify(file.commits.map((commit) => commit.sha))
    ) {
      errors.push(`${owner}: commits differ from the upstream first-parent slice`);
      continue;
    }
    actual.forEach((commit, index) => {
      if (file.commits[index]!.subject !== commit.subject)
        errors.push(`${owner}: subject differs for ${commit.sha}`);
    });
  }
  return errors;
}

// ── Base-ref rules (CI only) ────────────────────────────────────────────

export interface ChangedPath {
  /** Path relative to the repository root. */
  readonly path: string;
  /** `git diff --name-status` letter: A, M, D, R, C, T. */
  readonly status: string;
}

/**
 * Immutable files may only be added; ledger-state changes may only travel in
 * ledger-only PRs once the base already contains the v7 archive.
 */
export function evaluateBaseRefRules(input: {
  /**
   * Normalized ledger directories at HEAD and at the base. Checking both keeps
   * a PR that moves `ledgerDir` from escaping the rules for the old location.
   */
  readonly ledgerDirs: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<ChangedPath>;
  readonly baseHasArchive: boolean;
}): string[] {
  const errors: string[] = [];
  const prefixes = [...new Set(input.ledgerDirs)].map((dir) => `${dir}/`);
  const relative = (path: string) => {
    const prefix = prefixes.find((candidate) => path.startsWith(candidate));
    return prefix === undefined ? null : path.slice(prefix.length);
  };
  for (const change of input.changes) {
    const inLedger = relative(change.path);
    if (inLedger === null) continue;
    const immutable = IMMUTABLE_LEDGER_DIRS.some((dir) => inLedger.startsWith(`${dir}/`));
    if (immutable && change.status !== "A")
      errors.push(`${change.path} is immutable; it may only be added (status ${change.status})`);
  }
  if (input.baseHasArchive) {
    const touchesState = input.changes.some((change) => {
      const inLedger = relative(change.path);
      return inLedger !== null && isLedgerStatePath(inLedger);
    });
    if (touchesState) {
      const mixed = input.changes.filter((change) => {
        const inLedger = relative(change.path);
        return inLedger === null || !isLedgerStatePath(inLedger);
      });
      for (const change of mixed)
        errors.push(
          `${change.path}: ledger-state changes must travel in a ledger-only PR; move this change to a separate PR`,
        );
    }
  }
  return errors;
}

// ── Derived state ───────────────────────────────────────────────────────

/** Topic id to the set of epochs with a matching item (trailers or active links). */
export type EpochIndex = ReadonlyMap<string, ReadonlySet<number>>;

export interface DeriveTopicStateContext {
  readonly trailers: EpochIndex;
  readonly activeLinks: EpochIndex;
  /** `YYYY-MM-DD` in local time. */
  readonly today: string;
}

export function deriveTopicState(
  topic: Pick<UpstreamTopic, "id" | "status" | "epoch" | "revisitAfter">,
  context: DeriveTopicStateContext,
): UpstreamTopicState {
  if (topic.status === "equivalent" || context.trailers.get(topic.id)?.has(topic.epoch))
    return "done";
  switch (topic.status) {
    case "port":
      return context.activeLinks.get(topic.id)?.has(topic.epoch) ? "in-progress" : "ready";
    case "inbox":
      return "inbox";
    case "watch":
      return topic.revisitAfter !== undefined && topic.revisitAfter <= context.today
        ? "inbox"
        : "watch";
    case "skip":
    case "declined":
      return "skipped";
  }
}

export function indexEpochs(
  items: ReadonlyArray<{ readonly id: string; readonly epoch: number }>,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const item of items) {
    const set = out.get(item.id) ?? new Set<number>();
    set.add(item.epoch);
    out.set(item.id, set);
  }
  return out;
}

// ── Trailers ────────────────────────────────────────────────────────────

const TRAILER_PATTERN =
  /^Upstream-Topic: (pr-[1-9][0-9]*(?:-[0-9a-f]{7})?|c-[0-9a-f]{12})(?:#([1-9][0-9]*))?[ \t]*$/gmu;

/** Every `Upstream-Topic: <id>[#<epoch>]` line, anywhere in the text; CRLF tolerated. */
export function parseUpstreamTopicTrailers(
  text: string,
): Array<{ readonly id: string; readonly epoch: number }> {
  const out: Array<{ id: string; epoch: number }> = [];
  for (const match of text.replaceAll("\r\n", "\n").matchAll(TRAILER_PATTERN))
    out.push({ id: match[1]!, epoch: match[2] ? Number(match[2]) : 1 });
  return out;
}

export function formatUpstreamTopicTrailer(topic: Pick<UpstreamTopic, "id" | "epoch">): string {
  return topic.epoch === 1
    ? `Upstream-Topic: ${topic.id}`
    : `Upstream-Topic: ${topic.id}#${topic.epoch}`;
}

// ── Topic ids ───────────────────────────────────────────────────────────

const PR_SUFFIX_PATTERN = /\(#([1-9][0-9]*)\)\s*$/u;

export function prNumberFromSubject(subject: string): number | null {
  const match = PR_SUFFIX_PATTERN.exec(subject);
  return match ? Number(match[1]) : null;
}

/** Deterministic and globally unique given the ids already taken. */
export function topicIdFor(
  primaryCommit: { readonly sha: string; readonly pr?: number | null | undefined },
  takenIds: ReadonlySet<string>,
): string {
  if (primaryCommit.pr) {
    const base = `pr-${primaryCommit.pr}`;
    return takenIds.has(base) ? `${base}-${primaryCommit.sha.slice(0, 7)}` : base;
  }
  return `c-${primaryCommit.sha.slice(0, 12)}`;
}

// ── Reverts ─────────────────────────────────────────────────────────────

const REVERT_PATTERN = /This reverts commit ([0-9a-f]{40})/u;

export function findRevertTarget(body: string): string | null {
  return REVERT_PATTERN.exec(body)?.[1] ?? null;
}

export interface RevertCandidate {
  readonly sha: string;
  readonly body: string;
  readonly paths: ReadonlyArray<string>;
}

export interface RevertChain {
  /** The original change: the first commit in the chain that is not itself a revert of a known commit. */
  readonly root: string;
  /** Chain members in this batch, oldest first (may exclude the root when it predates the run). */
  readonly members: ReadonlyArray<string>;
  /** True when every revert in the chain touches exactly its target's paths. */
  readonly full: boolean;
  /** Number of reverts in the chain. Odd removes the root's change, even restores it. */
  readonly depth: number;
  readonly netEffect: "removed" | "restored";
  readonly rootInRun: boolean;
}

/**
 * Group reverts with what they revert. `commits` are this run's commits, oldest
 * first; `externalPaths` resolves changed paths for targets outside the run
 * (null when unknown, which makes the chain partial).
 */
export function buildRevertChains(
  commits: ReadonlyArray<RevertCandidate>,
  externalPaths: (sha: string) => ReadonlyArray<string> | null = () => null,
): RevertChain[] {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const targetOf = new Map<string, string>();
  for (const commit of commits) {
    const target = findRevertTarget(commit.body);
    if (target && target !== commit.sha) targetOf.set(commit.sha, target);
  }
  const rootOf = (sha: string): string => {
    let current = sha;
    const visited = new Set<string>();
    while (targetOf.has(current) && !visited.has(current)) {
      visited.add(current);
      current = targetOf.get(current)!;
    }
    return current;
  };
  const chains = new Map<string, string[]>();
  for (const commit of commits) {
    if (!targetOf.has(commit.sha)) continue;
    const root = rootOf(commit.sha);
    chains.set(root, [...(chains.get(root) ?? []), commit.sha]);
  }
  const samePaths = (a: ReadonlyArray<string>, b: ReadonlyArray<string> | null) =>
    b !== null && a.length === b.length && new Set([...a, ...b]).size === a.length;
  const out: RevertChain[] = [];
  for (const [root, reverts] of chains) {
    const rootInRun = bySha.has(root);
    const members = rootInRun ? [root, ...reverts] : reverts;
    const full = reverts.every((sha) => {
      const target = targetOf.get(sha)!;
      const targetPaths = bySha.get(target)?.paths ?? externalPaths(target);
      return samePaths(bySha.get(sha)!.paths, targetPaths);
    });
    const order = new Map(commits.map((commit, index) => [commit.sha, index]));
    out.push({
      root,
      members: members.toSorted((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1)),
      full,
      depth: reverts.length,
      netEffect: reverts.length % 2 === 1 ? "removed" : "restored",
      rootInRun,
    });
  }
  return out;
}

// ── Operations ──────────────────────────────────────────────────────────

/** Topic fields a decision owns; everything else is preserved. */
export const DECISION_FIELDS = [
  "status",
  "epoch",
  "reasonKey",
  "reason",
  "scope",
  "decidedBy",
  "decidedAt",
  "revisitAfter",
  "equivalence",
] as const satisfies ReadonlyArray<keyof UpstreamTopic>;

export type DecisionFields = Pick<UpstreamTopic, "status" | "epoch"> &
  Partial<Pick<UpstreamTopic, (typeof DECISION_FIELDS)[number]>>;

export type UpstreamLedgerOp =
  | {
      readonly kind: "interval";
      readonly file: IntervalFile;
      readonly topics: ReadonlyArray<UpstreamTopic>;
    }
  | {
      readonly kind: "legacy";
      readonly file: LegacyBatchFile;
      readonly topics: ReadonlyArray<UpstreamTopic>;
    }
  | {
      readonly kind: "decision";
      readonly topicId: string;
      readonly fields: DecisionFields;
    };

export function pickDecisionFields(topic: UpstreamTopic): DecisionFields {
  const out: Record<string, unknown> = {};
  for (const key of DECISION_FIELDS) if (topic[key] !== undefined) out[key] = topic[key];
  return out as DecisionFields;
}

export function applyDecisionFields(topic: UpstreamTopic, fields: DecisionFields): UpstreamTopic {
  const out: Record<string, unknown> = { ...topic };
  for (const key of DECISION_FIELDS) delete out[key];
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out as UpstreamTopic;
}

/** True when the op's effect is already in the ledger, compared by content. */
export function opEffectPresent(ledger: UpstreamLedger, op: UpstreamLedgerOp): boolean {
  if (op.kind === "decision") {
    const topic = ledger.topics.find((candidate) => candidate.id === op.topicId);
    return (
      topic !== undefined && canonicalJson(pickDecisionFields(topic)) === canonicalJson(op.fields)
    );
  }
  const files: ReadonlyArray<IntervalFile | LegacyBatchFile> =
    op.kind === "interval" ? ledger.intervals : ledger.legacy;
  const bytes = canonicalJson(op.file);
  const ids = new Set(ledger.topics.map((topic) => topic.id));
  return (
    files.some((file) => canonicalJson(file) === bytes) &&
    op.topics.every((topic) => ids.has(topic.id))
  );
}

export interface AppliedOps {
  readonly ledger: UpstreamLedger;
  readonly conflicts: ReadonlyArray<string>;
}

/** Replay ops in order onto a base ledger. Ops whose effect is present are no-ops. */
export function applyOps(base: UpstreamLedger, ops: ReadonlyArray<UpstreamLedgerOp>): AppliedOps {
  let intervals = [...base.intervals];
  let legacy = [...base.legacy];
  const topics = new Map(base.topics.map((topic) => [topic.id, topic]));
  const conflicts: string[] = [];
  for (const op of ops) {
    const current = { intervals, legacy, topics: [...topics.values()] };
    if (opEffectPresent(current, op)) continue;
    if (op.kind === "decision") {
      const topic = topics.get(op.topicId);
      if (!topic) {
        conflicts.push(`decision for unknown topic ${op.topicId}`);
        continue;
      }
      // Epochs only grow, and a decision is made against the newest epoch it
      // can see; a higher ledger epoch means another writer decided since.
      if (topic.epoch > op.fields.epoch) {
        conflicts.push(
          `decision for ${op.topicId} was made at epoch ${op.fields.epoch}, but the ledger is at epoch ${topic.epoch}`,
        );
        continue;
      }
      topics.set(op.topicId, applyDecisionFields(topic, op.fields));
      continue;
    }
    const existing = op.kind === "interval" ? intervals : legacy;
    const number = op.kind === "interval" ? op.file.interval : op.file.batch;
    const label = op.kind === "interval" ? `interval ${number}` : `legacy batch ${number}`;
    const sameNumber = existing.find(
      (file) => ("interval" in file ? file.interval : file.batch) === number,
    );
    if (sameNumber) {
      const ids = new Set(topics.keys());
      const missing = op.topics.filter((topic) => !ids.has(topic.id)).map((topic) => topic.id);
      conflicts.push(
        canonicalJson(sameNumber) === canonicalJson(op.file)
          ? `${label} is present, but its topics ${missing.join(", ")} are missing`
          : `${label} already exists with different content`,
      );
      continue;
    }
    if (number !== existing.length + 1) {
      conflicts.push(`${label} does not follow ${existing.length}`);
      continue;
    }
    if (op.kind === "interval") {
      const previousTarget = intervals.at(-1)?.targetSha;
      if (previousTarget !== undefined && op.file.baseSha !== previousTarget) {
        conflicts.push(`${label} does not start at the previous target`);
        continue;
      }
    }
    const collision = op.topics.find((topic) => {
      const prior = topics.get(topic.id);
      return prior !== undefined && canonicalJson(prior) !== canonicalJson(topic);
    });
    if (collision) {
      conflicts.push(`topic id ${collision.id} already exists with different content`);
      continue;
    }
    if (op.kind === "interval") intervals = [...intervals, op.file];
    else legacy = [...legacy, op.file];
    for (const topic of op.topics) if (!topics.has(topic.id)) topics.set(topic.id, topic);
  }
  return {
    ledger: {
      intervals,
      legacy,
      topics: [...topics.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
    conflicts,
  };
}

// ── Helpers for consumers ───────────────────────────────────────────────

export interface TopicMembership {
  readonly sha: string;
  readonly subject: string;
  readonly pr: number | null;
  readonly source: string;
}

/**
 * Each topic's commits, oldest first. Legacy batches hold archive deferred
 * commits, which predate interval 1, so they come first (in SHA order, as
 * stored); interval commits follow by interval, reversed from newest first.
 */
export function membersByTopic(ledger: UpstreamLedger): Map<string, TopicMembership[]> {
  const out = new Map<string, TopicMembership[]>();
  const add = (commit: UpstreamMembershipCommit, source: string) =>
    out.set(commit.topic, [
      ...(out.get(commit.topic) ?? []),
      { sha: commit.sha, subject: commit.subject, pr: commit.pr ?? null, source },
    ]);
  for (const file of ledger.legacy)
    for (const commit of file.commits) add(commit, `legacy batch ${file.batch}`);
  for (const file of ledger.intervals)
    for (const commit of file.commits.toReversed()) add(commit, `interval ${file.interval}`);
  return out;
}

export function coverageTarget(
  ledger: UpstreamLedger,
  archive: ArchiveContext | null,
): string | null {
  return ledger.intervals.at(-1)?.targetSha ?? archive?.lastTargetSha ?? null;
}

export function isOpenForMembership(status: UpstreamTopicStatus): boolean {
  return status === "inbox" || status === "watch";
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day! + days));
  return value.toISOString().slice(0, 10);
}

export function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
