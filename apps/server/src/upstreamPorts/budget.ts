/**
 * The budgeted Inbox: which topics expire unreviewed, which features the
 * weekly digest counts, and which topics a run may queue for porting on its
 * own. Pure; the service applies the results through the usual decision path.
 *
 * @module upstreamPorts/budget
 */
import type {
  UpstreamAutoPortMode,
  UpstreamExpireBacklogResult,
  UpstreamTopic,
} from "@t3tools/contracts";
import { addDays } from "@t3tools/shared/upstreamPorts";
import { featureAreaPolicy, type AreaPolicy } from "@t3tools/shared/upstreamPortsScore";

import type { DerivedRow } from "./view.ts";

export const AGED_OUT_REASON_KEY = "aged-out";
export const DEFAULT_EXPIRE_AFTER_DAYS = 14;
export const DIGEST_WINDOW_DAYS = 7;
/** A weekly schedule may drift by hours; anything past six days counts as a week. */
export const DIGEST_MIN_INTERVAL_MS = 6 * 24 * 60 * 60_000;
export const AUTO_PORT_MIN_CONFIDENCE = 0.85;
export const AUTO_PORT_REQUEST_PREFIX = "auto-port:";

/**
 * When the topic last entered the Inbox (`YYYY-MM-DD`): a watched topic
 * returns on its revisit date; otherwise its latest decision (a reopen) or
 * its creation.
 */
export function inboxSince(
  topic: Pick<UpstreamTopic, "status" | "revisitAfter" | "decidedAt" | "createdAt">,
): string {
  if (topic.status === "watch" && topic.revisitAfter) return topic.revisitAfter;
  return (topic.decidedAt ?? topic.createdAt).slice(0, 10);
}

export interface ExpiryOptions {
  readonly olderThanDays: number;
  readonly keepScore: number;
  /** Local `YYYY-MM-DD`. */
  readonly today: string;
  /** Topics with a port thread or queue entry for their current epoch. */
  readonly busyTopicIds: ReadonlySet<string>;
}

/**
 * Inbox topics outside the security lane that waited at least the window:
 * `olderThanDays`, doubled for topics scoring at least `keepScore`.
 */
export function expiryCandidates<Row extends DerivedRow>(
  rows: ReadonlyArray<Row>,
  options: ExpiryOptions,
): Row[] {
  return rows.filter((row) => {
    if (row.state !== "inbox" || row.lane === "security") return false;
    if (options.busyTopicIds.has(row.topic.id)) return false;
    const window =
      row.score >= options.keepScore ? options.olderThanDays * 2 : options.olderThanDays;
    return addDays(inboxSince(row.topic), window) <= options.today;
  });
}

export function countExpiryByLane(
  rows: ReadonlyArray<Pick<DerivedRow, "lane">>,
): UpstreamExpireBacklogResult["byLane"] {
  const byLane = { bug: 0, perf: 0, feature: 0, maintenance: 0 };
  for (const row of rows) if (row.lane !== "security") byLane[row.lane] += 1;
  return byLane;
}

/** Inbox features created in the last seven days, split by the area follow list. */
export function featureDigest(
  rows: ReadonlyArray<DerivedRow>,
  today: string,
  areaPolicy: Readonly<Record<string, AreaPolicy>>,
): { readonly followed: number; readonly other: number } {
  const since = addDays(today, -DIGEST_WINDOW_DAYS);
  let followed = 0;
  let other = 0;
  for (const row of rows) {
    if (row.state !== "inbox" || row.lane !== "feature") continue;
    if (row.topic.createdAt.slice(0, 10) <= since) continue;
    if (featureAreaPolicy(row.topic.suggestion?.areas ?? [], areaPolicy) === "follow")
      followed += 1;
    else other += 1;
  }
  return { followed, other };
}

/**
 * Topics a run may queue on its own, highest score first: confident port
 * suggestions without doubts, in the security lane at high or critical
 * severity, or (with `security-and-bugs`) high-impact bug fixes whose files
 * all exist in f5.
 */
export function autoPortCandidates<Row extends DerivedRow>(
  rows: ReadonlyArray<Row>,
  options: {
    readonly mode: UpstreamAutoPortMode;
    readonly topicIds: ReadonlySet<string>;
    readonly busyTopicIds: ReadonlySet<string>;
  },
): Row[] {
  if (options.mode === "off") return [];
  return rows
    .filter((row) => {
      const suggestion = row.topic.suggestion;
      if (
        !options.topicIds.has(row.topic.id) ||
        options.busyTopicIds.has(row.topic.id) ||
        row.state !== "inbox" ||
        row.topic.status !== "inbox" ||
        !suggestion ||
        suggestion.status !== "port" ||
        suggestion.confidence < AUTO_PORT_MIN_CONFIDENCE ||
        suggestion.question ||
        suggestion.conflict ||
        suggestion.triageError
      )
        return false;
      if (row.lane === "security")
        return suggestion.severity === "high" || suggestion.severity === "critical";
      return (
        options.mode === "security-and-bugs" &&
        row.lane === "bug" &&
        suggestion.userImpact === "high" &&
        suggestion.f5Coverage === "all"
      );
    })
    .toSorted((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));
}

/** Local midnight of `now`, as an ISO timestamp, for the daily auto-port limit. */
export function localDayStart(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
