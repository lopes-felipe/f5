/**
 * `/upstream` search params. The route definition loads at startup, so this
 * module stays tiny; page helpers live in `upstreamPage.logic.ts`.
 */
import {
  ProjectId,
  type UpstreamDecidedBy,
  type UpstreamSuggestionFilter,
  type UpstreamTopicList,
  type UpstreamTopicSort,
  type UpstreamUserImpact,
} from "@t3tools/contracts";

export interface UpstreamSearch {
  readonly project?: ProjectId;
  readonly list?: UpstreamTopicList;
  readonly topic?: string;
  /** Text search. */
  readonly q?: string;
  readonly suggestion?: ReadonlyArray<UpstreamSuggestionFilter>;
  readonly impact?: ReadonlyArray<UpstreamUserImpact>;
  readonly area?: string;
  /** Only topics with an open question. */
  readonly question?: true;
  /** Only topics whose triage passes disagreed. */
  readonly conflict?: true;
  /** Who made the decision; `llm` is "Automatic only". */
  readonly by?: UpstreamDecidedBy;
  readonly sort?: UpstreamTopicSort;
}

const UPSTREAM_LIST_IDS: ReadonlyArray<UpstreamTopicList> = [
  "inbox",
  "ready",
  "in-progress",
  "watch",
  "done",
  "skipped",
];
const SUGGESTIONS: ReadonlyArray<UpstreamSuggestionFilter> = ["port", "skip", "watch", "equivalent", "none"];
const IMPACTS: ReadonlyArray<UpstreamUserImpact> = ["high", "medium", "low", "none"];
const DECIDED_BY: ReadonlyArray<UpstreamDecidedBy> = ["user", "llm", "rule"];
const SORTS: ReadonlyArray<UpstreamTopicSort> = ["priority", "newest", "oldest", "confidence"];

const TOPIC_ID_PATTERN = /^(pr-[1-9][0-9]*(-[0-9a-f]{7})?|c-[0-9a-f]{12})$/u;

export const isUpstreamList = (value: unknown): value is UpstreamTopicList =>
  UPSTREAM_LIST_IDS.includes(value as UpstreamTopicList);

/** `?question=true`; the router parses JSON values, so accept the string forms too. */
const isFlag = (value: unknown) => value === 1 || value === "1" || value === true || value === "true";

const oneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
  values.includes(value as T);

/** A de-duplicated list of known values; a single value is accepted as a list of one. */
function listOf<T extends string>(values: ReadonlyArray<T>, value: unknown): T[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.filter((known) => raw.includes(known));
}

export function validateUpstreamSearch(search: Record<string, unknown>): UpstreamSearch {
  const suggestion = listOf(SUGGESTIONS, search.suggestion);
  const impact = listOf(IMPACTS, search.impact);
  const by = oneOf(DECIDED_BY, search.by) ? search.by : isFlag(search.auto) ? "llm" : undefined;
  return {
    ...(typeof search.project === "string" && search.project
      ? { project: ProjectId.makeUnsafe(search.project) }
      : {}),
    ...(isUpstreamList(search.list) ? { list: search.list } : {}),
    ...(typeof search.topic === "string" && TOPIC_ID_PATTERN.test(search.topic)
      ? { topic: search.topic }
      : {}),
    ...(typeof search.q === "string" && search.q.trim() ? { q: search.q.slice(0, 200) } : {}),
    ...(suggestion.length ? { suggestion } : {}),
    ...(impact.length ? { impact } : {}),
    ...(typeof search.area === "string" && search.area ? { area: search.area.slice(0, 100) } : {}),
    ...(isFlag(search.question) ? { question: true as const } : {}),
    ...(isFlag(search.conflict) ? { conflict: true as const } : {}),
    ...(by ? { by } : {}),
    ...(oneOf(SORTS, search.sort) ? { sort: search.sort } : {}),
  };
}

/** `search` without its default values, so the URL stays short. */
export function compactUpstreamSearch(search: UpstreamSearch): UpstreamSearch {
  return {
    ...(search.project ? { project: search.project } : {}),
    ...(search.list && search.list !== "inbox" ? { list: search.list } : {}),
    ...(search.topic ? { topic: search.topic } : {}),
    ...(search.q?.trim() ? { q: search.q } : {}),
    ...(search.suggestion?.length ? { suggestion: search.suggestion } : {}),
    ...(search.impact?.length ? { impact: search.impact } : {}),
    ...(search.area ? { area: search.area } : {}),
    ...(search.question ? { question: true as const } : {}),
    ...(search.conflict ? { conflict: true as const } : {}),
    ...(search.by ? { by: search.by } : {}),
    ...(search.sort ? { sort: search.sort } : {}),
  };
}
