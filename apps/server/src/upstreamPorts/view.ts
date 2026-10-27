/**
 * The ledger view: `applyOps(ledger at origin/<base>, open ops)` plus derived
 * topic state, list ordering and cursor pagination. Pure; the service loads
 * the inputs and caches the result.
 *
 * @module upstreamPorts/view
 */
import {
  UPSTREAM_LIST_DEFAULT_LIMIT,
  UPSTREAM_LIST_IDS_MAX,
  UPSTREAM_MAX_FILES_PER_COMMIT,
  type UpstreamChangedFile,
  type ThreadId,
  type UpstreamCommitFiles,
  type UpstreamHistoryPublication,
  type UpstreamTopicFiles,
  type UpstreamTopicHistoryEntry,
  type UpstreamListTopicsInput,
  type UpstreamListTopicsResult,
  type UpstreamStateCounts,
  type UpstreamSuggestionFilter,
  type UpstreamTopic,
  type UpstreamTopicFacets,
  type UpstreamTopicFilter,
  type UpstreamTopicSort,
  type UpstreamTopicState,
} from "@t3tools/contracts";
import {
  applyOps,
  deriveTopicState,
  indexEpochs,
  membersByTopic,
  parseUpstreamTopicTrailers,
  sha256Hex,
  canonicalJson,
  type EpochIndex,
  type TopicMembership,
  type UpstreamLedger,
} from "@t3tools/shared/upstreamPorts";

import type { CommitNumstat, TrailerCommit } from "./git.ts";
import type { OpRecord, OpState, PortLinkRecord } from "./store.ts";

export interface TrailerIndex {
  readonly epochs: EpochIndex;
  /** `<topicId>#<epoch>` to the PR number (`#N`) or f5 SHA that carried the trailer. */
  readonly doneBy: ReadonlyMap<string, string>;
}

const MERGE_SUBJECT = /^Merge pull request #([1-9][0-9]*)\b/u;

/** Oldest commit wins for doneBy; `git log` lists newest first. */
export function indexTrailers(commits: ReadonlyArray<TrailerCommit>): TrailerIndex {
  const items: Array<{ id: string; epoch: number }> = [];
  const doneBy = new Map<string, string>();
  for (const commit of [...commits].toReversed()) {
    const trailers = parseUpstreamTopicTrailers(commit.body);
    const label = MERGE_SUBJECT.exec(commit.subject)?.[1];
    for (const trailer of trailers) {
      items.push(trailer);
      const key = `${trailer.id}#${trailer.epoch}`;
      const value = label ? `#${label}` : commit.sha.slice(0, 12);
      // Prefer the merge commit's PR number over a squashed commit SHA.
      if (!doneBy.has(key) || (label && !doneBy.get(key)!.startsWith("#"))) doneBy.set(key, value);
    }
  }
  return { epochs: indexEpochs(items), doneBy };
}

export const EMPTY_TRAILERS: TrailerIndex = { epochs: new Map(), doneBy: new Map() };

export interface LedgerView {
  readonly baseSha: string | null;
  readonly base: UpstreamLedger;
  readonly ledger: UpstreamLedger;
  readonly openOps: ReadonlyArray<OpRecord>;
  readonly conflicts: ReadonlyArray<string>;
  readonly topicsById: ReadonlyMap<string, UpstreamTopic>;
  readonly members: ReadonlyMap<string, ReadonlyArray<TopicMembership>>;
}

export function buildView(
  baseSha: string | null,
  base: UpstreamLedger,
  openOps: ReadonlyArray<OpRecord>,
): LedgerView {
  const applied = applyOps(
    base,
    openOps.map((record) => record.op),
  );
  return {
    baseSha,
    base,
    ledger: applied.ledger,
    openOps,
    conflicts: applied.conflicts,
    topicsById: new Map(applied.ledger.topics.map((topic) => [topic.id, topic])),
    members: membersByTopic(applied.ledger),
  };
}

export interface DerivedRow {
  readonly topic: UpstreamTopic;
  readonly state: UpstreamTopicState;
  readonly commitCount: number;
  readonly doneBy: string | null;
}

export function activeLinkIndex(links: ReadonlyArray<PortLinkRecord>): EpochIndex {
  return indexEpochs(
    links
      .filter((link) => link.state === "active")
      .map((link) => ({ id: link.topicId, epoch: link.epoch })),
  );
}

export function deriveRows(
  view: LedgerView,
  trailers: TrailerIndex,
  links: ReadonlyArray<PortLinkRecord>,
  today: string,
): DerivedRow[] {
  const activeLinks = activeLinkIndex(links);
  return view.ledger.topics.map((topic) => {
    const state = deriveTopicState(topic, { trailers: trailers.epochs, activeLinks, today });
    return {
      topic,
      state,
      commitCount: view.members.get(topic.id)?.length ?? 0,
      doneBy: state === "done" ? (trailers.doneBy.get(`${topic.id}#${topic.epoch}`) ?? null) : null,
    };
  });
}

export function countStates(rows: ReadonlyArray<DerivedRow>): UpstreamStateCounts {
  const counts = { inbox: 0, ready: 0, "in-progress": 0, watch: 0, done: 0, skipped: 0 };
  for (const row of rows) counts[row.state] += 1;
  return counts;
}

export function revisionOf(input: {
  readonly baseSha: string | null;
  readonly maxSeq: number;
  readonly linksVersion: number;
  readonly today: string;
}): string {
  return sha256Hex(
    `${input.baseSha ?? "none"}\n${input.maxSeq}\n${input.linksVersion}\n${input.today}\n`,
  ).slice(0, 32);
}

// ── Ordering and pagination ─────────────────────────────────────────────

const IMPACT_RANK = { high: 0, medium: 1, low: 2, none: 3 } as const;

type SortKey = readonly [number, number, string, string];

/** The sort a list uses when the request names none. */
export function resolveSort(
  list: UpstreamTopicState,
  sort: UpstreamTopicSort | undefined,
): UpstreamTopicSort {
  return sort ?? (list === "inbox" ? "priority" : "newest");
}

/** Ascending tuple order; descending fields are negated or inverted. */
export function sortKey(sort: UpstreamTopicSort, topic: UpstreamTopic): SortKey {
  const suggestion = topic.suggestion;
  const impact = suggestion ? IMPACT_RANK[suggestion.userImpact] : 1;
  const confidence = suggestion?.confidence ?? 0;
  switch (sort) {
    case "priority":
      return [impact, -confidence, invert(topic.createdAt), topic.id];
    case "newest":
      return [0, 0, invert(topic.createdAt), topic.id];
    case "oldest":
      return [0, 0, topic.createdAt, topic.id];
    case "confidence":
      return [-confidence, impact, invert(topic.createdAt), topic.id];
  }
}

// ── Filters and facets ──────────────────────────────────────────────────

/** Commit subjects per topic, for query matching. */
export type SubjectsOf = (topicId: string) => ReadonlyArray<string>;

const NO_SUBJECTS: SubjectsOf = () => [];

type FacetDimension = "suggestion" | "impact" | "area";

const suggestionKey = (topic: UpstreamTopic): UpstreamSuggestionFilter =>
  topic.suggestion?.status ?? "none";

function matchesQuery(topic: UpstreamTopic, needle: string, subjectsOf: SubjectsOf): boolean {
  const haystack = [
    topic.title,
    topic.summary,
    topic.id,
    ...topic.upstreamPrs.map(String),
    topic.suggestion?.reason ?? "",
    ...(topic.suggestion?.areas ?? []),
    ...subjectsOf(topic.id),
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

type RowFilter = (row: DerivedRow, skip?: FacetDimension | null) => boolean;

/**
 * Compiles `filter` once for a pass over many rows: the query needle is
 * normalized once, and each topic's query match is remembered so the facet
 * passes do not rebuild its haystack.
 */
function compileFilter(filter: UpstreamTopicFilter, subjectsOf: SubjectsOf): RowFilter {
  const needle = (filter.query ?? "").trim().toLowerCase().replace(/^#/u, "");
  const queryMatches = new Map<string, boolean>();
  const matchesNeedle = (topic: UpstreamTopic) => {
    let match = queryMatches.get(topic.id);
    if (match === undefined) {
      match = matchesQuery(topic, needle, subjectsOf);
      queryMatches.set(topic.id, match);
    }
    return match;
  };
  return ({ topic }, skip = null) => {
    if (filter.decidedBy !== undefined && topic.decidedBy !== filter.decidedBy) return false;
    if (
      filter.hasQuestion !== undefined &&
      Boolean(topic.suggestion?.question) !== filter.hasQuestion
    )
      return false;
    if (
      filter.hasConflict !== undefined &&
      Boolean(topic.suggestion?.conflict) !== filter.hasConflict
    )
      return false;
    if (
      skip !== "suggestion" &&
      filter.suggestion?.length &&
      !filter.suggestion.includes(suggestionKey(topic))
    )
      return false;
    if (
      skip !== "impact" &&
      filter.impact?.length &&
      !(topic.suggestion && filter.impact.includes(topic.suggestion.userImpact))
    )
      return false;
    if (skip !== "area" && filter.area && !(topic.suggestion?.areas ?? []).includes(filter.area))
      return false;
    if (needle && !matchesNeedle(topic)) return false;
    return true;
  };
}

/** Whether `row` passes `filter`, ignoring the `skip` dimension (for its facet counts). */
export function matchesFilter(
  row: DerivedRow,
  filter: UpstreamTopicFilter,
  subjectsOf: SubjectsOf = NO_SUBJECTS,
  skip: FacetDimension | null = null,
): boolean {
  return compileFilter(filter, subjectsOf)(row, skip);
}

const MAX_AREA_FACETS = 20;

/** Facets of a page past the first; clients read facets from the first page only. */
const EMPTY_FACETS: UpstreamTopicFacets = {
  suggestion: { port: 0, skip: 0, watch: 0, equivalent: 0, none: 0 },
  impact: { high: 0, medium: 0, low: 0, none: 0 },
  areas: [],
};

export function computeFacets(
  listRows: ReadonlyArray<DerivedRow>,
  filter: UpstreamTopicFilter,
  subjectsOf: SubjectsOf = NO_SUBJECTS,
  compiled: RowFilter = compileFilter(filter, subjectsOf),
): UpstreamTopicFacets {
  const suggestion = { port: 0, skip: 0, watch: 0, equivalent: 0, none: 0 };
  const impact = { high: 0, medium: 0, low: 0, none: 0 };
  const areas = new Map<string, number>();
  for (const row of listRows) {
    if (compiled(row, "suggestion")) suggestion[suggestionKey(row.topic)] += 1;
    const userImpact = row.topic.suggestion?.userImpact;
    if (userImpact && compiled(row, "impact")) impact[userImpact] += 1;
    if (compiled(row, "area"))
      for (const area of new Set(row.topic.suggestion?.areas ?? []))
        areas.set(area, (areas.get(area) ?? 0) + 1);
  }
  const top = [...areas]
    .map(([area, count]) => ({ area, count }))
    .toSorted((a, b) => b.count - a.count || a.area.localeCompare(b.area))
    .slice(0, MAX_AREA_FACETS);
  // The active area stays listed so the Filter menu can show it as selected.
  if (filter.area && !top.some((entry) => entry.area === filter.area))
    top.push({ area: filter.area, count: areas.get(filter.area) ?? 0 });
  return { suggestion, impact, areas: top };
}

interface ListQuery {
  readonly list: UpstreamTopicState;
  readonly filter?: UpstreamTopicFilter | undefined;
  readonly sort?: UpstreamTopicSort | undefined;
}

/** Every row of the list that passes the filter, in sort order, with its sort key. */
export function selectRows<Row extends DerivedRow>(
  rows: ReadonlyArray<Row>,
  input: ListQuery,
  subjectsOf: SubjectsOf = NO_SUBJECTS,
  compiled: RowFilter = compileFilter(input.filter ?? {}, subjectsOf),
): Array<{ readonly row: Row; readonly key: SortKey }> {
  const sort = resolveSort(input.list, input.sort);
  return rows
    .filter((row) => row.state === input.list && compiled(row))
    .map((row) => ({ row, key: sortKey(sort, row.topic) }))
    .toSorted((a, b) => compareKeys(a.key, b.key));
}

/** The ids `listTopicIds` returns: the whole filtered list, capped. */
export function listTopicIds(
  rows: ReadonlyArray<DerivedRow>,
  input: ListQuery,
  subjectsOf: SubjectsOf = NO_SUBJECTS,
): { readonly topicIds: string[]; readonly truncated: boolean } {
  const selected = selectRows(rows, input, subjectsOf);
  return {
    topicIds: selected.slice(0, UPSTREAM_LIST_IDS_MAX).map((entry) => entry.row.topic.id),
    truncated: selected.length > UPSTREAM_LIST_IDS_MAX,
  };
}

/** Maps each character so lexical ascending order becomes descending (ISO strings are ASCII). */
function invert(value: string): string {
  let out = "";
  for (const char of value) out += String.fromCharCode(0x7f - char.charCodeAt(0));
  return out;
}

export function compareKeys(a: SortKey, b: SortKey): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

interface CursorPayload {
  readonly signature: string;
  readonly revision: string;
  readonly key: SortKey;
}

const listSignature = (input: UpstreamListTopicsInput, limit: number) =>
  sha256Hex(
    canonicalJson({
      list: input.list,
      filter: input.filter ?? {},
      sort: resolveSort(input.list, input.sort),
      limit,
    }),
  ).slice(0, 16);

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (
      typeof value?.signature !== "string" ||
      typeof value.revision !== "string" ||
      !Array.isArray(value.key) ||
      value.key.length !== 4
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function pageRows<Row extends DerivedRow>(
  rows: ReadonlyArray<Row>,
  input: UpstreamListTopicsInput,
  revision: string,
  subjectsOf: SubjectsOf = NO_SUBJECTS,
): Omit<UpstreamListTopicsResult, "topics"> & { readonly rows: ReadonlyArray<Row> } {
  const limit = input.limit ?? UPSTREAM_LIST_DEFAULT_LIMIT;
  const signature = listSignature(input, limit);
  const filter = input.filter ?? {};
  const compiled = compileFilter(filter, subjectsOf);
  const selected = selectRows(rows, input, subjectsOf, compiled);
  const facets =
    input.cursor === undefined
      ? computeFacets(
          rows.filter((row) => row.state === input.list),
          filter,
          subjectsOf,
          compiled,
        )
      : EMPTY_FACETS;
  let after: SortKey | null = null;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor || cursor.signature !== signature || cursor.revision !== revision)
      return {
        revision,
        status: "cursor_stale",
        rows: [],
        nextCursor: null,
        total: selected.length,
        facets,
      };
    after = cursor.key;
  }
  const start =
    after === null ? 0 : selected.findIndex((entry) => compareKeys(entry.key, after!) > 0);
  const page = start < 0 ? [] : selected.slice(start, start + limit);
  const hasMore = start >= 0 && start + limit < selected.length;
  return {
    revision,
    status: "ok",
    rows: page.map((entry) => entry.row),
    nextCursor: hasMore ? encodeCursor({ signature, revision, key: page.at(-1)!.key }) : null,
    total: selected.length,
    facets,
  };
}

// ── Topic detail extras ──

/**
 * Files per commit: the counted files first (git numstat counts at most 15),
 * then the remaining paths without counts. A commit missing from `numstat`
 * is not in the local clone.
 */
export function buildTopicFiles(
  shas: ReadonlyArray<string>,
  numstat: ReadonlyMap<string, CommitNumstat>,
  pathsInF5: ReadonlySet<string> | null,
): UpstreamTopicFiles {
  const exists = (file: string) => (pathsInF5 ? pathsInF5.has(file) : null);
  const unique = new Set<string>();
  const totals = { files: 0, added: 0, deleted: 0, existingInF5: 0 };
  const commits = shas.map((sha): UpstreamCommitFiles => {
    const entry = numstat.get(sha);
    if (!entry) return { sha, available: false, files: [], totalFiles: 0, truncated: false };
    const counted = new Set(entry.files.map((file) => file.path));
    const all: UpstreamChangedFile[] = [
      ...entry.files.map((file) => ({ ...file, existsInF5: exists(file.path) })),
      ...entry.paths
        .filter((file) => !counted.has(file))
        .map((file) => ({ path: file, added: null, deleted: null, existsInF5: exists(file) })),
    ];
    for (const file of all) {
      totals.added += file.added ?? 0;
      totals.deleted += file.deleted ?? 0;
      if (unique.has(file.path)) continue;
      unique.add(file.path);
      totals.files += 1;
      if (file.existsInF5) totals.existingInF5 += 1;
    }
    const totalFiles = Math.max(entry.totalFiles, all.length);
    const files = all.slice(0, UPSTREAM_MAX_FILES_PER_COMMIT);
    return { sha, available: true, files, totalFiles, truncated: files.length < totalFiles };
  });
  return { commits, totals };
}

const PUBLICATION_BY_STATE: Record<OpState, UpstreamHistoryPublication> = {
  recorded: "pending",
  merged: "published",
  superseded: "superseded",
  discarded: "discarded",
};

const decisionDetails = (fields: {
  readonly status: UpstreamTopic["status"];
  readonly decidedBy?: UpstreamTopic["decidedBy"];
  readonly reasonKey?: string;
  readonly reason?: string;
}) => ({
  status: fields.status,
  ...(fields.decidedBy ? { decidedBy: fields.decidedBy } : {}),
  ...(fields.reasonKey ? { reasonKey: fields.reasonKey } : {}),
  ...(fields.reason ? { reason: fields.reason } : {}),
});

/**
 * The topic's timeline, oldest first: its creation, this profile's decision
 * ops, the decision on the base ledger when no op accounts for it (another
 * writer, or a decision older than the kept ops), and port threads. Links
 * have no unlink time, so an unlink follows its port start.
 */
export function buildTopicHistory(input: {
  readonly topic: UpstreamTopic;
  /** The topic on origin/<base>, or undefined while only an open op has it. */
  readonly baseTopic: UpstreamTopic | undefined;
  readonly ops: ReadonlyArray<OpRecord>;
  readonly links: ReadonlyArray<PortLinkRecord>;
}): UpstreamTopicHistoryEntry[] {
  const { topic, baseTopic } = input;
  const timed: UpstreamTopicHistoryEntry[] = [];
  const decisions = input.ops.filter((record) => record.op.kind === "decision");
  for (const record of decisions) {
    if (record.op.kind !== "decision") continue;
    timed.push({
      at: record.createdAt,
      kind: "decided",
      epoch: record.op.fields.epoch,
      publication: PUBLICATION_BY_STATE[record.state],
      ...decisionDetails(record.op.fields),
    });
  }
  const decidedAt = baseTopic?.decidedAt;
  if (
    baseTopic &&
    decidedAt &&
    !decisions.some(
      (record) => record.op.kind === "decision" && record.op.fields.decidedAt === decidedAt,
    )
  )
    timed.push({
      at: decidedAt,
      kind: "decided",
      epoch: baseTopic.epoch,
      publication: "ledger",
      ...decisionDetails(baseTopic),
    });
  const links = input.links.filter((link) => link.topicId === topic.id);
  const untimed: UpstreamTopicHistoryEntry[] = [];
  const unlinkedAfter = new Map<UpstreamTopicHistoryEntry, UpstreamTopicHistoryEntry>();
  for (const link of links) {
    const started: UpstreamTopicHistoryEntry = {
      at: link.startedAt ?? null,
      kind: "port-started",
      epoch: link.epoch,
      threadId: link.threadId as ThreadId,
    };
    (started.at === null ? untimed : timed).push(started);
    if (link.state === "unlinked")
      unlinkedAfter.set(started, { ...started, at: null, kind: "unlinked" });
  }
  timed.sort((left, right) => (left.at! < right.at! ? -1 : left.at! > right.at! ? 1 : 0));
  const created: UpstreamTopicHistoryEntry = {
    at: topic.createdAt,
    kind: "created",
    epoch: 1,
    publication: baseTopic ? "published" : "pending",
  };
  return [created, ...untimed, ...timed].flatMap((entry) => {
    const unlinked = unlinkedAfter.get(entry);
    return unlinked ? [entry, unlinked] : [entry];
  });
}
