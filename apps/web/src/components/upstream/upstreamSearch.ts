/**
 * `/upstream` search params. The route definition loads at startup, so this
 * module stays tiny; page helpers live in `upstreamPage.logic.ts`.
 */
import { ProjectId, type UpstreamTopicList } from "@t3tools/contracts";

export interface UpstreamSearch {
  readonly project?: ProjectId;
  readonly list?: UpstreamTopicList;
  readonly topic?: string;
}

const UPSTREAM_LIST_IDS: ReadonlyArray<UpstreamTopicList> = [
  "inbox",
  "ready",
  "in-progress",
  "watch",
  "done",
  "skipped",
];

const TOPIC_ID_PATTERN = /^(pr-[1-9][0-9]*(-[0-9a-f]{7})?|c-[0-9a-f]{12})$/u;

export const isUpstreamList = (value: unknown): value is UpstreamTopicList =>
  UPSTREAM_LIST_IDS.includes(value as UpstreamTopicList);

export function validateUpstreamSearch(search: Record<string, unknown>): UpstreamSearch {
  return {
    ...(typeof search.project === "string" && search.project
      ? { project: ProjectId.makeUnsafe(search.project) }
      : {}),
    ...(isUpstreamList(search.list) ? { list: search.list } : {}),
    ...(typeof search.topic === "string" && TOPIC_ID_PATTERN.test(search.topic)
      ? { topic: search.topic }
      : {}),
  };
}
