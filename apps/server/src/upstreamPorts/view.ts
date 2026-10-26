/**
 * The ledger view: `applyOps(ledger at origin/<base>, open ops)` plus derived
 * topic state, list ordering and cursor pagination. Pure; the service loads
 * the inputs and caches the result.
 *
 * @module upstreamPorts/view
 */
import {
  UPSTREAM_LIST_DEFAULT_LIMIT,
  type UpstreamListTopicsInput,
  type UpstreamListTopicsResult,
  type UpstreamStateCounts,
  type UpstreamTopic,
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

/** Ascending tuple order; descending fields are negated or inverted. */
export function sortKey(list: UpstreamTopicState, topic: UpstreamTopic): SortKey {
  const created = invert(topic.createdAt);
  if (list !== "inbox") return [0, 0, created, topic.id];
  const suggestion = topic.suggestion;
  return [
    suggestion ? IMPACT_RANK[suggestion.userImpact] : 1,
    -(suggestion?.confidence ?? 0),
    created,
    topic.id,
  ];
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
  sha256Hex(canonicalJson({ list: input.list, filter: input.filter ?? {}, limit })).slice(0, 16);

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
): Omit<UpstreamListTopicsResult, "topics"> & { readonly rows: ReadonlyArray<Row> } {
  const limit = input.limit ?? UPSTREAM_LIST_DEFAULT_LIMIT;
  const signature = listSignature(input, limit);
  let after: SortKey | null = null;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor || cursor.signature !== signature || cursor.revision !== revision)
      return { revision, status: "cursor_stale", rows: [], nextCursor: null };
    after = cursor.key;
  }
  const filter = input.filter ?? {};
  const selected = rows
    .filter(
      (row) =>
        row.state === input.list &&
        (filter.decidedBy === undefined || row.topic.decidedBy === filter.decidedBy) &&
        (filter.hasQuestion === undefined ||
          Boolean(row.topic.suggestion?.question) === filter.hasQuestion),
    )
    .map((row) => ({ row, key: sortKey(input.list, row.topic) }))
    .toSorted((a, b) => compareKeys(a.key, b.key));
  const start =
    after === null ? 0 : selected.findIndex((entry) => compareKeys(entry.key, after!) > 0);
  const page = start < 0 ? [] : selected.slice(start, start + limit);
  const hasMore = start >= 0 && start + limit < selected.length;
  return {
    revision,
    status: "ok",
    rows: page.map((entry) => entry.row),
    nextCursor: hasMore ? encodeCursor({ signature, revision, key: page.at(-1)!.key }) : null,
  };
}
