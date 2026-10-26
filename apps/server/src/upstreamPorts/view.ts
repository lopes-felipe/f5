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

import type { TrailerCommit } from "./git.ts";
import type { OpRecord, PortLinkRecord } from "./store.ts";

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

function matchesQuery(topic: UpstreamTopic, query: string, subjectsOf: SubjectsOf): boolean {
  const needle = query.trim().toLowerCase().replace(/^#/u, "");
  if (!needle) return true;
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

/** Whether `row` passes `filter`, ignoring the `skip` dimension (for its facet counts). */
export function matchesFilter(
  row: DerivedRow,
  filter: UpstreamTopicFilter,
  subjectsOf: SubjectsOf = NO_SUBJECTS,
  skip: FacetDimension | null = null,
): boolean {
  const { topic } = row;
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
  if (filter.query && !matchesQuery(topic, filter.query, subjectsOf)) return false;
  return true;
}

const MAX_AREA_FACETS = 20;

export function computeFacets(
  listRows: ReadonlyArray<DerivedRow>,
  filter: UpstreamTopicFilter,
  subjectsOf: SubjectsOf = NO_SUBJECTS,
): UpstreamTopicFacets {
  const suggestion = { port: 0, skip: 0, watch: 0, equivalent: 0, none: 0 };
  const impact = { high: 0, medium: 0, low: 0, none: 0 };
  const areas = new Map<string, number>();
  for (const row of listRows) {
    if (matchesFilter(row, filter, subjectsOf, "suggestion"))
      suggestion[suggestionKey(row.topic)] += 1;
    const userImpact = row.topic.suggestion?.userImpact;
    if (userImpact && matchesFilter(row, filter, subjectsOf, "impact")) impact[userImpact] += 1;
    if (matchesFilter(row, filter, subjectsOf, "area"))
      for (const area of new Set(row.topic.suggestion?.areas ?? []))
        areas.set(area, (areas.get(area) ?? 0) + 1);
  }
  return {
    suggestion,
    impact,
    areas: [...areas]
      .map(([area, count]) => ({ area, count }))
      .toSorted((a, b) => b.count - a.count || a.area.localeCompare(b.area))
      .slice(0, MAX_AREA_FACETS),
  };
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
): Array<{ readonly row: Row; readonly key: SortKey }> {
  const filter = input.filter ?? {};
  const sort = resolveSort(input.list, input.sort);
  return rows
    .filter((row) => row.state === input.list && matchesFilter(row, filter, subjectsOf))
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
  const selected = selectRows(rows, input, subjectsOf);
  const facets = computeFacets(
    rows.filter((row) => row.state === input.list),
    input.filter ?? {},
    subjectsOf,
  );
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
