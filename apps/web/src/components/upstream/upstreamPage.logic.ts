import {
  UPSTREAM_MAX_DECIDE_TOPICS,
  UPSTREAM_MAX_PORT_GROUPS,
  UPSTREAM_MAX_PORT_TOPICS,
  type ProjectId,
  type ProjectSettingsOverrides,
  type UpstreamDecidedBy,
  type UpstreamDecision,
  type UpstreamHistoryPublication,
  type UpstreamListTopicsResult,
  type UpstreamOverview,
  type UpstreamPortsSettings,
  type UpstreamPortLinkSummary,
  type UpstreamStateCounts,
  type UpstreamSuggestionFilter,
  type UpstreamTopic,
  type UpstreamTopicFiles,
  type UpstreamTopicFilter,
  type UpstreamTopicHistoryEntry,
  type UpstreamTopicList,
  type UpstreamTopicSort,
  type UpstreamTopicStatus,
  type UpstreamTopicSuggestion,
  type UpstreamUserImpact,
} from "@t3tools/contracts";
import type { InfiniteData } from "@tanstack/react-query";

import type { UpstreamSearch } from "./upstreamSearch";

export const UPSTREAM_LISTS: ReadonlyArray<{ readonly id: UpstreamTopicList; readonly label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "ready", label: "Ready" },
  { id: "in-progress", label: "In progress" },
  { id: "watch", label: "Watch" },
  { id: "done", label: "Done" },
  { id: "skipped", label: "Skipped" },
];

export { isUpstreamList } from "./upstreamSearch";

export const UPSTREAM_STATE_LABELS: Readonly<Record<UpstreamTopicList, string>> = {
  inbox: "Inbox",
  ready: "Ready",
  "in-progress": "In progress",
  watch: "Watch",
  done: "Done",
  skipped: "Skipped",
};

/** `85%`: confidence as a whole percentage. */
export const formatConfidence = (value: number) => `${Math.round(value * 100)}%`;

const SUGGESTION_VERBS: Readonly<Record<UpstreamTopicSuggestion["status"], string>> = {
  port: "Port",
  skip: "Skip",
  watch: "Watch",
  equivalent: "Equivalent",
};

export const suggestionVerb = (suggestion: Pick<UpstreamTopicSuggestion, "status">) =>
  SUGGESTION_VERBS[suggestion.status];

/** `Port 92%`, `Skip: mobile 97%`, `Equivalent 70%`. */
export function suggestionChipLabel(suggestion: UpstreamTopicSuggestion): string {
  const confidence = formatConfidence(suggestion.confidence);
  if (suggestion.status === "skip" && suggestion.reasonKey) return `Skip: ${suggestion.reasonKey} ${confidence}`;
  return `${suggestionVerb(suggestion)} ${confidence}`;
}

/** Badge variant per suggested verb: Port stands out, Skip recedes. */
export function suggestionBadgeVariant(
  status: UpstreamTopicSuggestion["status"],
): "primary-soft" | "secondary" | "warning" | "success" {
  switch (status) {
    case "port":
      return "primary-soft";
    case "skip":
      return "secondary";
    case "watch":
      return "warning";
    case "equivalent":
      return "success";
  }
}

/** Impact marker color. Red is kept for errors, so high impact uses the warning color. */
export function impactClassName(impact: UpstreamTopicSuggestion["userImpact"] | undefined): string {
  switch (impact) {
    case "high":
      return "bg-warning";
    case "medium":
      return "bg-info";
    case "low":
      return "bg-muted-foreground/50";
    case "none":
      return "bg-transparent border border-muted-foreground/40";
    default:
      return "bg-transparent border border-dashed border-muted-foreground/40";
  }
}

export const impactLabel = (impact: UpstreamTopicSuggestion["userImpact"] | undefined) =>
  impact ? `Impact: ${impact}` : "Impact: not triaged";

/**
 * After a decision removes rows, focus moves to the next surviving id in the
 * pre-mutation order, or the previous one when the focused row was last.
 */
export function focusAfterRemoval(
  orderBefore: ReadonlyArray<string>,
  removed: ReadonlySet<string>,
  focused: string | null,
): string | null {
  if (focused === null || !removed.has(focused)) return focused;
  const index = orderBefore.indexOf(focused);
  for (let next = index + 1; next < orderBefore.length; next += 1)
    if (!removed.has(orderBefore[next]!)) return orderBefore[next]!;
  for (let previous = index - 1; previous >= 0; previous -= 1)
    if (!removed.has(orderBefore[previous]!)) return orderBefore[previous]!;
  return null;
}

/** After a refetch, a missing id falls back to the row at the same index. */
export function reconcileFocus(
  ids: ReadonlyArray<string>,
  focused: string | null,
  previousIndex: number,
): string | null {
  if (ids.length === 0) return null;
  if (focused !== null && ids.includes(focused)) return focused;
  return ids[Math.min(Math.max(previousIndex, 0), ids.length - 1)]!;
}

export function moveFocus(ids: ReadonlyArray<string>, focused: string | null, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const index = focused === null ? -1 : ids.indexOf(focused);
  if (index < 0) return ids[delta === 1 ? 0 : ids.length - 1]!;
  return ids[Math.min(Math.max(index + delta, 0), ids.length - 1)]!;
}

/** Splits a selection into requests the server accepts (`UPSTREAM_MAX_DECIDE_TOPICS` each). */
export function decisionBatches(topicIds: ReadonlyArray<string>): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < topicIds.length; start += UPSTREAM_MAX_DECIDE_TOPICS)
    batches.push(topicIds.slice(start, start + UPSTREAM_MAX_DECIDE_TOPICS));
  return batches;
}

/**
 * What a bulk action applies to: the selected topics that are visible, in list
 * order, or the focused row when no selected topic is visible (a filter can hide them).
 */
export function actionTargets(
  ids: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
  focused: string | null,
): string[] {
  const visible = ids.filter((id) => selected.has(id));
  if (visible.length > 0) return visible;
  return focused !== null && ids.includes(focused) ? [focused] : [];
}

/**
 * The state of each topic: its loaded row's, else `unloaded`. "Select all
 * matching" only selects topics of the current list, so that list's state is
 * the right answer for the ones past the loaded pages.
 */
export function topicStates(
  rows: ReadonlyArray<{ readonly topic: { readonly id: string }; readonly state: string }>,
  unloaded: string,
): (topicId: string) => string {
  const states = new Map(rows.map((row) => [row.topic.id, row.state]));
  return (topicId) => states.get(topicId) ?? unloaded;
}

/** Topics that can be ported: Ready or In progress. */
export function portableTopicIds(
  stateOf: (topicId: string) => string | undefined,
  topicIds: ReadonlyArray<string>,
): string[] {
  return topicIds.filter((id) => stateOf(id) === "ready" || stateOf(id) === "in-progress");
}

export function promptLimitError(topicCount: number): string | null {
  if (topicCount === 0) return "Select at least one topic.";
  if (topicCount > UPSTREAM_MAX_PORT_TOPICS)
    return `Copy a prompt for at most ${UPSTREAM_MAX_PORT_TOPICS} topics at once.`;
  return null;
}

export interface UpstreamView {
  readonly projectId: string | null;
  readonly list: UpstreamTopicList;
  readonly focused: string | null;
}

/**
 * Whether a decision that started in `started` may still move focus: only if
 * the user stayed on the same project and list and did not move focus meanwhile.
 */
export function canMoveFocusAfterDecision(started: UpstreamView, current: UpstreamView): boolean {
  return (
    started.projectId === current.projectId &&
    started.list === current.list &&
    started.focused === current.focused
  );
}

export function portLimitError(topicCount: number, grouping: "together" | "separately"): string | null {
  if (topicCount === 0) return "Select at least one topic.";
  if (topicCount > UPSTREAM_MAX_PORT_TOPICS) return `Start at most ${UPSTREAM_MAX_PORT_TOPICS} topics at once.`;
  if (grouping === "separately" && topicCount > UPSTREAM_MAX_PORT_GROUPS)
    return `Start at most ${UPSTREAM_MAX_PORT_GROUPS} separate threads at once, or port the topics together.`;
  return null;
}

/** Record equivalent from a finished port thread: its PR, plus the outcome's `path:line` evidence. */
export function equivalentFromLink(link: UpstreamPortLinkSummary): UpstreamDecision {
  const evidence =
    link.outcome?.kind === "equivalent"
      ? link.outcome.detail
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => /^[^\s:]+:[1-9][0-9]*$/u.test(entry))
      : [];
  return {
    kind: "equivalent",
    ...(link.prNumber !== null ? { f5Refs: [`#${link.prNumber}`] } : {}),
    ...(evidence.length ? { evidence } : {}),
  };
}

/**
 * The project's full override set with `patch` applied to its upstream settings.
 * The server replaces a project's overrides wholesale, so every other key must be sent back.
 */
export function upstreamSettingsOverrides(
  overrides: ProjectSettingsOverrides,
  current: UpstreamPortsSettings,
  patch: Partial<UpstreamPortsSettings>,
): ProjectSettingsOverrides {
  return { ...overrides, upstreamPorts: { ...current, ...patch } };
}

/** Move to Watch from a `blocked` outcome. */
export function watchFromBlocked(link: UpstreamPortLinkSummary): UpstreamDecision | null {
  if (link.outcome?.kind !== "blocked") return null;
  return { kind: "watch", reason: `Blocked: ${link.outcome.detail}` };
}

export function upstreamPrUrl(repository: string, pr: number): string {
  return `${repository.replace(/\.git$/u, "").replace(/\/$/u, "")}/pull/${pr}`;
}

export function upstreamCommitUrl(repository: string, sha: string): string {
  return `${repository.replace(/\.git$/u, "").replace(/\/$/u, "")}/commit/${sha}`;
}

/** The skip reason key preselected by `s`: the suggestion's key when it suggests skipping. */
export function preselectedSkipReason(topic: Pick<UpstreamTopic, "suggestion">): string | null {
  return topic.suggestion?.status === "skip" ? (topic.suggestion.reasonKey ?? null) : null;
}

/** Inputs that take no typing, such as row checkboxes, keep list shortcuts active. */
const NON_TEXT_INPUTS = ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]
  .map((type) => `:not([type=${type}])`)
  .join("");

export const isEditableTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest(`input${NON_TEXT_INPUTS}, textarea, select, [contenteditable=true]`));

export const isDialogTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest("[role=dialog], [role=alertdialog], [role=menu]"));

/** Buttons, links and checkboxes, which Enter and Space must activate rather than run a list shortcut. */
export const isControlTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest("button, a[href], input, [role=button], [role=checkbox], [role=link]"));

/** Keys a focused control handles itself. */
export const isActivationKey = (key: string) => key === "Enter" || key === " ";

// ── Selection ──────────────────────────────────────────────────────────

/** Adds every id between `anchor` and `target` (inclusive, list order) to the selection. */
export function selectRange(
  ids: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
  anchor: string | null,
  target: string,
): Set<string> {
  const next = new Set(selected);
  const to = ids.indexOf(target);
  if (to < 0) return next;
  const from = anchor === null ? -1 : ids.indexOf(anchor);
  if (from < 0) {
    next.add(target);
    return next;
  }
  for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) next.add(ids[index]!);
  return next;
}

export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Shift+J/K: moves focus and selects both the row it leaves and the row it lands on. */
export function extendSelection(
  ids: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
  focused: string | null,
  delta: 1 | -1,
): { readonly focused: string | null; readonly selected: Set<string> } {
  const next = new Set(selected);
  const target = moveFocus(ids, focused, delta);
  if (focused !== null && ids.includes(focused)) next.add(focused);
  if (target !== null) next.add(target);
  return { focused: target, selected: next };
}

/** The header checkbox: all loaded rows, some of them, or none. */
export function headerCheckState(
  ids: ReadonlyArray<string>,
  selected: ReadonlySet<string>,
): "all" | "some" | "none" {
  const count = ids.filter((id) => selected.has(id)).length;
  if (count === 0) return "none";
  return count === ids.length ? "all" : "some";
}

// ── Actions ────────────────────────────────────────────────────────────

export type UpstreamBulkAction =
  | "accept"
  | "port"
  | "skip"
  | "watch"
  | "decline"
  | "equivalent"
  | "reopen"
  | "startPort"
  | "copyPrompt";

/** The bulk bar's actions for each list, in display order. */
export function bulkActionsForList(list: UpstreamTopicList): ReadonlyArray<UpstreamBulkAction> {
  switch (list) {
    case "inbox":
      return ["accept", "port", "skip", "watch", "decline", "equivalent"];
    case "ready":
    case "in-progress":
      return ["startPort", "copyPrompt", "reopen", "skip"];
    case "watch":
      return ["reopen", "port", "skip", "decline", "equivalent"];
    case "done":
      return ["reopen", "port", "skip", "watch", "decline"];
    case "skipped":
      return ["reopen", "port", "watch", "equivalent"];
  }
}

export const UPSTREAM_LIST_IDS: ReadonlyArray<UpstreamTopicList> = UPSTREAM_LISTS.map((entry) => entry.id);

/** `]` and `[`: the next or previous list, wrapping around. */
export function adjacentList(list: UpstreamTopicList, delta: 1 | -1): UpstreamTopicList {
  const index = UPSTREAM_LIST_IDS.indexOf(list);
  return UPSTREAM_LIST_IDS[(index + delta + UPSTREAM_LIST_IDS.length) % UPSTREAM_LIST_IDS.length]!;
}

/**
 * The list a topic most likely lands in after `decision`, for optimistic
 * updates; `null` when it stays put or cannot be predicted. The refetch that
 * follows every decision has the final word.
 */
/**
 * Whether accepting the suggestion records a decision. The server refuses a
 * failed triage and a skip without a reason key (`suggestionDecision`).
 */
export function canAcceptSuggestion(suggestion: UpstreamTopicSuggestion | undefined): suggestion is UpstreamTopicSuggestion {
  return Boolean(suggestion && !suggestion.triageError && !(suggestion.status === "skip" && !suggestion.reasonKey));
}

export function predictedState(
  row: { readonly state: UpstreamTopicList; readonly topic: Pick<UpstreamTopic, "suggestion"> },
  decision: UpstreamDecision | "accept",
): UpstreamTopicList | null {
  const kind =
    decision === "accept"
      ? canAcceptSuggestion(row.topic.suggestion)
        ? row.topic.suggestion.status
        : null
      : decision.kind;
  const target = (() => {
    switch (kind) {
      case null:
        return null;
      case "port":
        return row.state === "in-progress" ? "in-progress" : "ready";
      case "skip":
      case "declined":
        return "skipped";
      case "watch":
        return "watch";
      case "equivalent":
        return "done";
      case "inbox":
        return "inbox";
    }
  })();
  return target === row.state ? null : target;
}

/** Overview counts after moving topics between lists. */
export function adjustCounts(
  counts: UpstreamStateCounts,
  moves: ReadonlyArray<{ readonly from: UpstreamTopicList; readonly to: UpstreamTopicList }>,
): UpstreamStateCounts {
  const next = { ...counts };
  for (const move of moves) {
    next[move.from] = Math.max(0, next[move.from] - 1);
    next[move.to] += 1;
  }
  return next;
}

/** Drops `removed` topics from every loaded page of a topic list. */
export function withoutTopics(
  data: InfiniteData<UpstreamListTopicsResult> | undefined,
  removed: ReadonlySet<string>,
): InfiniteData<UpstreamListTopicsResult> | undefined {
  if (!data) return data;
  const gone = data.pages.flatMap((page) => page.topics.filter((row) => removed.has(row.topic.id)));
  if (gone.length === 0) return data;
  // Every removed row matched the whole filter, so it counted once in each facet dimension.
  const suggestion = { ...data.pages[0]!.facets.suggestion };
  const impact = { ...data.pages[0]!.facets.impact };
  const areaDrops = new Map<string, number>();
  for (const { topic } of gone) {
    const verb = topic.suggestion?.status ?? "none";
    suggestion[verb] = Math.max(0, suggestion[verb] - 1);
    const userImpact = topic.suggestion?.userImpact;
    if (userImpact) impact[userImpact] = Math.max(0, impact[userImpact] - 1);
    for (const area of new Set(topic.suggestion?.areas ?? [])) areaDrops.set(area, (areaDrops.get(area) ?? 0) + 1);
  }
  return {
    ...data,
    pages: data.pages.map((page, index) => ({
      ...page,
      topics: page.topics.filter((row) => !removed.has(row.topic.id)),
      total: Math.max(0, page.total - gone.length),
      facets:
        index === 0
          ? {
              suggestion,
              impact,
              areas: page.facets.areas.map((entry) => ({
                area: entry.area,
                count: Math.max(0, entry.count - (areaDrops.get(entry.area) ?? 0)),
              })),
            }
          : page.facets,
    })),
  };
}

/** `1 topic`, `1,204 topics`. */
export const topicCount = (count: number) => `${count.toLocaleString()} topic${count === 1 ? "" : "s"}`;

/** The confirmation note for a decision that reaches topics past the loaded rows. */
export const unseenNote = (unseen: number) =>
  `${topicCount(unseen)} ${unseen === 1 ? "is" : "are"} not loaded in the list, so you have not seen ${unseen === 1 ? "it" : "them"}.`;

/** Toast title after a decision: `Skipped 12 topics`. */
export function decisionToastTitle(decision: UpstreamDecision | "accept", count: number): string {
  const noun = topicCount(count);
  if (decision === "accept") return `Accepted suggestions for ${noun}`;
  switch (decision.kind) {
    case "port":
      return `Marked ${noun} ready`;
    case "skip":
      return `Skipped ${noun}`;
    case "declined":
      return `Declined ${noun}`;
    case "watch":
      return `Watching ${noun}`;
    case "equivalent":
      return `Recorded ${noun} as already in f5`;
    case "inbox":
      return `Moved ${noun} back to Inbox`;
  }
}

// ── Undo ───────────────────────────────────────────────────────────────

/** A minute under the server's 15, so the page never offers an undo that has expired. */
export const UNDO_WINDOW_MS = 14 * 60_000;
export const UNDO_STACK_MAX = 20;

export interface UndoEntry {
  /** Also the toast id. */
  readonly id: string;
  readonly projectId: ProjectId;
  /** Every batch of the action joins this one token. */
  readonly token: string;
  readonly title: string;
  readonly expiresAt: number;
}

export function liveUndoEntries(entries: ReadonlyArray<UndoEntry>, now: number): UndoEntry[] {
  return entries.filter((entry) => entry.expiresAt > now);
}

export function undoToastTitle(count: number): string {
  return `Undid the decision for ${count} topic${count === 1 ? "" : "s"}`;
}

/** The note for topics an undo left alone; they changed since, in one of several ways. */
export function undoKeptTitle(count: number): string {
  return `${topicCount(count)} changed since and ${count === 1 ? "was" : "were"} left as ${count === 1 ? "it is" : "they are"}`;
}

// ── Changed files and history ──────────────────────────────────────────

export function formatFileTotals(totals: UpstreamTopicFiles["totals"]): string {
  const files = `${totals.files.toLocaleString()} file${totals.files === 1 ? "" : "s"}`;
  return `${files} · +${totals.added.toLocaleString()} −${totals.deleted.toLocaleString()} · ${totals.existingInF5.toLocaleString()} exist in f5`;
}

export interface TopicFileRow {
  readonly path: string;
  /** Summed over the commits that report counts; `null` when none do. */
  readonly added: number | null;
  readonly deleted: number | null;
  /** The newest commit that touches the path, for the file link. */
  readonly sha: string;
  readonly diffAnchor: string;
  readonly existsInF5: boolean | null;
}

/** One row per path across the topic's commits, in first-seen order. */
export function aggregateTopicFiles(files: UpstreamTopicFiles): TopicFileRow[] {
  const rows = new Map<string, TopicFileRow>();
  const sum = (left: number | null, right: number | null) =>
    left === null ? right : right === null ? left : left + right;
  for (const commit of files.commits)
    for (const file of commit.files) {
      const previous = rows.get(file.path);
      rows.set(file.path, {
        path: file.path,
        added: sum(previous?.added ?? null, file.added),
        deleted: sum(previous?.deleted ?? null, file.deleted),
        sha: commit.sha,
        diffAnchor: file.diffAnchor,
        existsInF5: file.existsInF5,
      });
    }
  return [...rows.values()];
}

/**
 * `https://github.com/o/r/commit/<sha>#diff-…`: the file's change in that
 * commit, which also works when the commit deleted it. Null off GitHub.
 */
export function upstreamFileDiffUrl(repository: string, sha: string, diffAnchor: string): string | null {
  const base = repositoryUrl(repository);
  if (!base.startsWith("https://github.com/")) return null;
  return `${base}/commit/${sha}#${encodeURIComponent(diffAnchor)}`;
}

/** The note for a file list that does not cover the whole topic, or null. */
export function topicFilesNote(files: UpstreamTopicFiles): string | null {
  const notes: string[] = [];
  if (files.totalCommits > files.commits.length)
    notes.push(
      `Only the first ${files.commits.length.toLocaleString()} of ${files.totalCommits.toLocaleString()} commits are listed.`,
    );
  if (files.commits.some((commit) => commit.truncated))
    notes.push("Very large commits list only their first files.");
  return notes.length ? notes.join(" ") : null;
}

const HISTORY_STATUS_LABELS: Record<UpstreamTopicStatus, string> = {
  inbox: "Moved to Inbox",
  port: "Marked ready",
  skip: "Skipped",
  declined: "Declined",
  watch: "Watching",
  equivalent: "Recorded as already in f5",
};

export function historyEntryLabel(entry: UpstreamTopicHistoryEntry): string {
  switch (entry.kind) {
    case "created":
      return "Triaged into the ledger";
    case "port-started":
      return "Port thread started";
    case "unlinked":
      return "Port thread unlinked";
    case "decided":
      return entry.status ? HISTORY_STATUS_LABELS[entry.status] : "Decided";
  }
}

export const HISTORY_PUBLICATION_LABELS: Record<UpstreamHistoryPublication, string> = {
  pending: "Unpublished",
  published: "Published",
  superseded: "Replaced",
  discarded: "Discarded",
  ledger: "From the ledger",
};

// ── Header ─────────────────────────────────────────────────────────────

/** `https://github.com/pingdotgg/t3code.git` → `pingdotgg/t3code`. */
export function shortRepository(repository: string): string {
  return repository
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

export function repositoryUrl(repository: string): string {
  return repository.replace(/\.git$/u, "").replace(/\/$/u, "");
}

export interface RunStatus {
  readonly tone: "running" | "failed" | "idle" | "never";
  readonly label: string;
}

/** The run status chip: running, failed, or the last sync time and the next run. */
export function runStatus(
  overview: Pick<UpstreamOverview, "activeRun" | "lastRun" | "nextRunAt" | "occurrence">,
  formatRelative: (iso: string) => string,
  formatNext: (iso: string) => string,
): RunStatus {
  const next = overview.nextRunAt ? ` · next ${formatNext(overview.nextRunAt)}` : "";
  if (overview.activeRun) {
    const left = overview.activeRun.remainingCount;
    return { tone: "running", label: left > 0 ? `Triaging… ${left} left` : "Triaging…" };
  }
  if (overview.occurrence?.status === "failed") return { tone: "failed", label: "Scheduled run failed" };
  const last = overview.lastRun;
  if (!last) return { tone: "never", label: `Never run${next}` };
  if (last.status === "failed") return { tone: "failed", label: "Last run failed" };
  return { tone: "idle", label: `Synced ${formatRelative(last.finishedAt ?? last.startedAt)}${next}` };
}

/** Why Run is disabled, or `null` when it can run. */
export function runDisabledReason(input: {
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly overview: Pick<UpstreamOverview, "activeRun" | "remoteStatus">;
}): string | null {
  if (input.readOnly) return "Another profile manages this repository.";
  if (input.overview.activeRun) return "A run is in progress.";
  if (input.overview.remoteStatus === "missing") return "The upstream remote is missing.";
  if (input.overview.remoteStatus === "mismatch") return "The upstream remote points at another repository.";
  if (input.busy) return "Another action is in progress.";
  return null;
}

/** The ledger chip label: `#228 · 11 unpublished`. */
export function ledgerChipLabel(publication: UpstreamOverview["publication"]): string | null {
  const parts: string[] = [];
  if (publication.prNumber !== null) parts.push(`#${publication.prNumber}`);
  if (publication.unpublishedOps > 0) parts.push(`${publication.unpublishedOps} unpublished`);
  if (parts.length === 0 && publication.pausedReason) parts.push("Publishing paused");
  return parts.length ? parts.join(" · ") : null;
}

// ── Search and filters ─────────────────────────────────────────────────

export const SUGGESTION_FILTER_LABELS: Readonly<Record<UpstreamSuggestionFilter, string>> = {
  port: "Port",
  skip: "Skip",
  watch: "Watch",
  equivalent: "Equivalent",
  none: "No suggestion",
};

export const IMPACT_LABELS: Readonly<Record<UpstreamUserImpact, string>> = {
  high: "High impact",
  medium: "Medium impact",
  low: "Low impact",
  none: "No impact",
};

export const DECIDED_BY_LABELS: Readonly<Record<UpstreamDecidedBy, string>> = {
  user: "Decided by you",
  llm: "Automatic (LLM)",
  rule: "Automatic (rule)",
};

export const SORT_LABELS: Readonly<Record<UpstreamTopicSort, string>> = {
  priority: "Priority",
  newest: "Newest",
  oldest: "Oldest",
  confidence: "Confidence",
};

/** The fields of the page's search params that filter the list. */
type FilterSearch = Pick<
  UpstreamSearch,
  "q" | "suggestion" | "impact" | "area" | "question" | "conflict" | "by"
>;

/** The server filter for the page's search params. */
export function filterFromSearch(search: FilterSearch): UpstreamTopicFilter {
  const query = search.q?.trim();
  return {
    ...(query ? { query } : {}),
    ...(search.suggestion?.length ? { suggestion: [...search.suggestion] } : {}),
    ...(search.impact?.length ? { impact: [...search.impact] } : {}),
    ...(search.area ? { area: search.area } : {}),
    ...(search.question ? { hasQuestion: true } : {}),
    ...(search.conflict ? { hasConflict: true } : {}),
    ...(search.by ? { decidedBy: search.by } : {}),
  };
}

export const hasActiveFilters = (search: FilterSearch) => Object.keys(filterFromSearch(search)).length > 0;

/** `search` with every filter removed; the list, project, sort and focus stay. */
export function withoutFilters(search: UpstreamSearch): UpstreamSearch {
  const { q: _q, suggestion: _s, impact: _i, area: _a, question: _qu, conflict: _c, by: _b, ...rest } = search;
  return rest;
}

export interface FilterChip {
  readonly key: string;
  readonly label: string;
  /** The search params without this chip's filter. */
  readonly remove: (search: UpstreamSearch) => UpstreamSearch;
}

/** One removable chip per active filter value. */
export function activeFilterChips(search: FilterSearch): FilterChip[] {
  const chips: FilterChip[] = [];
  const query = search.q?.trim();
  if (query) chips.push({ key: "q", label: `“${query}”`, remove: ({ q: _q, ...rest }) => rest });
  for (const value of search.suggestion ?? [])
    chips.push({
      key: `suggestion:${value}`,
      label: SUGGESTION_FILTER_LABELS[value],
      remove: (current) => {
        const { suggestion, ...rest } = current;
        const next = (suggestion ?? []).filter((entry) => entry !== value);
        return next.length ? { ...rest, suggestion: next } : rest;
      },
    });
  for (const value of search.impact ?? [])
    chips.push({
      key: `impact:${value}`,
      label: IMPACT_LABELS[value],
      remove: (current) => {
        const { impact, ...rest } = current;
        const next = (impact ?? []).filter((entry) => entry !== value);
        return next.length ? { ...rest, impact: next } : rest;
      },
    });
  if (search.area) chips.push({ key: "area", label: `Area: ${search.area}`, remove: ({ area: _a, ...rest }) => rest });
  if (search.question)
    chips.push({ key: "question", label: "Has question", remove: ({ question: _q, ...rest }) => rest });
  if (search.conflict)
    chips.push({ key: "conflict", label: "Has conflict", remove: ({ conflict: _c, ...rest }) => rest });
  if (search.by) chips.push({ key: "by", label: DECIDED_BY_LABELS[search.by], remove: ({ by: _b, ...rest }) => rest });
  return chips;
}

/** Adds or removes `value` from a multi-value filter. */
export function toggleValue<T extends string>(values: ReadonlyArray<T> | undefined, value: T): T[] {
  const current = values ?? [];
  return current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
}

/** Start port for every Ready topic, capped at the per-start limit. */
export function startAllReady(ids: ReadonlyArray<string>): { readonly ids: string[]; readonly capped: boolean } {
  return { ids: ids.slice(0, UPSTREAM_MAX_PORT_TOPICS), capped: ids.length > UPSTREAM_MAX_PORT_TOPICS };
}
