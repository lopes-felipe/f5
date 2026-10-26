import {
  UPSTREAM_MAX_DECIDE_TOPICS,
  UPSTREAM_MAX_PORT_GROUPS,
  UPSTREAM_MAX_PORT_TOPICS,
  type ProjectSettingsOverrides,
  type UpstreamDecision,
  type UpstreamPortsSettings,
  type UpstreamPortLinkSummary,
  type UpstreamTopic,
  type UpstreamTopicList,
  type UpstreamTopicSuggestion,
} from "@t3tools/contracts";

export const UPSTREAM_LISTS: ReadonlyArray<{ readonly id: UpstreamTopicList; readonly label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "ready", label: "Ready" },
  { id: "in-progress", label: "In progress" },
  { id: "watch", label: "Watch" },
  { id: "done", label: "Done" },
  { id: "skipped", label: "Skipped" },
];

export { isUpstreamList } from "./upstreamSearch";

const formatConfidence = (value: number) => value.toFixed(2);

/** `Port 0.92`, `Skip: mobile 0.97`, `Equivalent 0.70`. */
export function suggestionChipLabel(suggestion: UpstreamTopicSuggestion): string {
  const confidence = formatConfidence(suggestion.confidence);
  switch (suggestion.status) {
    case "port":
      return `Port ${confidence}`;
    case "skip":
      return suggestion.reasonKey ? `Skip: ${suggestion.reasonKey} ${confidence}` : `Skip ${confidence}`;
    case "watch":
      return `Watch ${confidence}`;
    case "equivalent":
      return `Equivalent ${confidence}`;
  }
}

export function impactClassName(impact: UpstreamTopicSuggestion["userImpact"] | undefined): string {
  switch (impact) {
    case "high":
      return "bg-destructive";
    case "low":
      return "bg-muted-foreground/50";
    case "none":
      return "bg-transparent border border-muted-foreground/40";
    default:
      return "bg-warning";
  }
}

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

/** Topics that can be ported: Ready or In progress. */
export function portableTopicIds(
  rows: ReadonlyArray<{ readonly topic: { readonly id: string }; readonly state: string }>,
  topicIds: ReadonlyArray<string>,
): string[] {
  const states = new Map(rows.map((row) => [row.topic.id, row.state]));
  return topicIds.filter((id) => states.get(id) === "ready" || states.get(id) === "in-progress");
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
