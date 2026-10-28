import type {
  CodexCollaborationAgentStatus,
  CodexCollaborationTool,
  CompactSubagentState,
  RuntimeItemStatus,
} from "@t3tools/contracts";

import { classifyCompactCommand } from "@t3tools/shared/commandSummary";

/** A small pixel band prevents a large viewport from rearming while the reader is in history. */
export const TIMELINE_AT_END_PX = 40;

export function timelineIsAtEnd(state: {
  contentLength: number;
  scroll: number;
  scrollLength: number;
}): boolean {
  return state.contentLength - state.scroll - state.scrollLength < TIMELINE_AT_END_PX;
}

import { extractTrailingAttachedFiles } from "../../lib/attachedFiles";
import type { WorkLogEntry } from "../../session-logic";
import { extractTrailingTerminalContexts } from "../../lib/terminalContext";

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/** The work-entry fields the classifiers below read. */
export type WorkEntryClassificationSource = Pick<
  WorkLogEntry,
  | "label"
  | "toolTitle"
  | "command"
  | "itemType"
  | "requestKind"
  | "searchSummary"
  | "readPaths"
  | "fileChangeId"
  | "changedFiles"
  | "tone"
  | "subagentType"
>;

export function normalizedWorkEntryHeading(
  workEntry: Pick<WorkLogEntry, "label" | "toolTitle">,
): string {
  return normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label).trim();
}

export function normalizedSearchSummary(
  workEntry: Pick<WorkLogEntry, "command" | "searchSummary">,
): string | null {
  if (workEntry.command) {
    const commandClassification = classifyCompactCommand(workEntry.command);
    if (commandClassification.kind === "search") {
      return commandClassification.summary;
    }
  }

  const searchSummary = workEntry.searchSummary?.trim();
  return searchSummary && searchSummary.length > 0 ? searchSummary : null;
}

export function isSearchWorkEntry(
  workEntry: Pick<
    WorkLogEntry,
    "command" | "itemType" | "label" | "requestKind" | "searchSummary" | "toolTitle"
  >,
): boolean {
  if (normalizedSearchSummary(workEntry)) {
    return true;
  }

  if (workEntry.requestKind !== "command" && workEntry.itemType !== "command_execution") {
    return false;
  }

  return normalizedWorkEntryHeading(workEntry).toLowerCase().startsWith("searching ");
}

export function isFileReadWorkEntry(
  workEntry: Pick<WorkLogEntry, "label" | "readPaths" | "requestKind" | "toolTitle">,
): boolean {
  if (workEntry.requestKind === "file-read" || (workEntry.readPaths?.length ?? 0) > 0) {
    return true;
  }
  const normalizedLabel = normalizedWorkEntryHeading(workEntry).toLowerCase();
  return normalizedLabel === "read" || normalizedLabel === "read file";
}

export function isFileChangeWorkEntry(
  workEntry: Pick<
    WorkLogEntry,
    "fileChangeId" | "itemType" | "label" | "requestKind" | "toolTitle"
  >,
): boolean {
  if (
    workEntry.fileChangeId ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change"
  ) {
    return true;
  }
  const normalizedLabel = normalizedWorkEntryHeading(workEntry).toLowerCase();
  return normalizedLabel === "file change" || normalizedLabel === "write file";
}

type WorkSummaryBucket = "edit" | "read" | "search" | "command" | "agent" | "tool" | "error";

const WORK_SUMMARY_BUCKET_ORDER: ReadonlyArray<WorkSummaryBucket> = [
  "edit",
  "read",
  "search",
  "command",
  "agent",
  "tool",
  "error",
];

export const WORK_SUMMARY_MAX_BUCKETS = 4;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const WORK_SUMMARY_BUCKET_LABEL: Record<WorkSummaryBucket, (count: number) => string> = {
  edit: (count) => `Edited ${plural(count, "file")}`,
  read: (count) => `Read ${plural(count, "file")}`,
  search: (count) => plural(count, "search", "searches"),
  command: (count) => `Ran ${plural(count, "command")}`,
  agent: (count) => plural(count, "agent"),
  tool: (count) => plural(count, "tool call"),
  error: (count) => plural(count, "error"),
};

function classifyWorkEntryForSummary(entry: WorkEntryClassificationSource): {
  bucket: WorkSummaryBucket;
  weight: number;
} | null {
  if (entry.tone === "error") return { bucket: "error", weight: 1 };
  if (isFileChangeWorkEntry(entry)) {
    return { bucket: "edit", weight: Math.max(1, entry.changedFiles?.length ?? 0) };
  }
  if (isSearchWorkEntry(entry)) return { bucket: "search", weight: 1 };
  if (isFileReadWorkEntry(entry)) {
    return { bucket: "read", weight: Math.max(1, entry.readPaths?.length ?? 0) };
  }
  if (entry.subagentType) return { bucket: "agent", weight: 1 };
  if (entry.command || entry.itemType === "command_execution" || entry.requestKind === "command") {
    return { bucket: "command", weight: 1 };
  }
  if (entry.tone === "tool") return { bucket: "tool", weight: 1 };
  return null;
}

/**
 * One-line summary of a collapsed work group, e.g. "Edited 2 files · Read 5
 * files · Ran 3 commands · 1 more". At most four buckets are named; the rest
 * are counted as "N more". Thinking and info entries are not counted.
 */
export function summarizeWorkGroup(entries: ReadonlyArray<WorkEntryClassificationSource>): string {
  const totals = new Map<WorkSummaryBucket, number>();
  const entryCounts = new Map<WorkSummaryBucket, number>();
  for (const entry of entries) {
    const classified = classifyWorkEntryForSummary(entry);
    if (!classified) continue;
    totals.set(classified.bucket, (totals.get(classified.bucket) ?? 0) + classified.weight);
    entryCounts.set(classified.bucket, (entryCounts.get(classified.bucket) ?? 0) + 1);
  }
  const present = WORK_SUMMARY_BUCKET_ORDER.filter((bucket) => totals.has(bucket));
  if (present.length === 0) {
    return plural(entries.length, "step");
  }
  const named = present.slice(0, WORK_SUMMARY_MAX_BUCKETS);
  const parts = named.map((bucket) => WORK_SUMMARY_BUCKET_LABEL[bucket](totals.get(bucket) ?? 0));
  const remaining = present
    .slice(WORK_SUMMARY_MAX_BUCKETS)
    .reduce((sum, bucket) => sum + (entryCounts.get(bucket) ?? 0), 0);
  if (remaining > 0) parts.push(`${remaining} more`);
  return parts.join(" · ");
}

/**
 * Index of the newest user message row, or -1. Work groups above it belong to
 * finished turns and may collapse; the latest turn never collapses under the
 * reader.
 */
export function findLastUserMessageRowIndex(
  rows: ReadonlyArray<{ readonly kind: string; readonly message?: { readonly role: string } }>,
): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message?.role === "user") return index;
  }
  return -1;
}

export interface TimelineRowIndexSource {
  readonly id: string;
  readonly groupedEntryIds?: ReadonlyArray<string>;
}

export function buildTimelineEntryRowIndexMap(
  rows: ReadonlyArray<TimelineRowIndexSource>,
): Map<string, number> {
  const map = new Map<string, number>();
  rows.forEach((row, index) => {
    map.set(row.id, index);
    for (const entryId of row.groupedEntryIds ?? []) map.set(entryId, index);
  });
  return map;
}

function evenlySample(values: ReadonlyArray<number>, count: number): number[] {
  if (values.length <= count) return [...values];
  if (count <= 1) return values.length > 0 ? [values[0]!] : [];
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push(values[Math.round((index * (values.length - 1)) / (count - 1))]!);
  }
  return [...new Set(result)];
}

export function sampleTimelineMinimapRowIndices(input: {
  readonly rowCount: number;
  readonly boundaryIndices: ReadonlyArray<number>;
  readonly activeRowIndex: number;
  readonly maxMarkers?: number;
}): number[] {
  const maxMarkers = Math.max(2, input.maxMarkers ?? 200);
  if (input.rowCount <= 0) return [];
  if (input.rowCount <= maxMarkers) {
    return Array.from({ length: input.rowCount }, (_, index) => index);
  }

  const last = input.rowCount - 1;
  const active = Math.min(last, Math.max(0, input.activeRowIndex));
  const mandatory = [
    0,
    ...input.boundaryIndices.filter((index) => index > 0 && index < last),
    active,
    last,
  ].sort((left, right) => left - right);
  const uniqueMandatory = [...new Set(mandatory)];
  const anchors = [...new Set([0, active, last])];
  const keptMandatory =
    uniqueMandatory.length <= maxMarkers
      ? uniqueMandatory
      : [
          ...anchors,
          ...evenlySample(
            uniqueMandatory.filter((index) => !anchors.includes(index)),
            maxMarkers - anchors.length,
          ),
        ].sort((left, right) => left - right);
  if (keptMandatory.length >= maxMarkers) return keptMandatory;

  const remaining = maxMarkers - keptMandatory.length;
  const mandatorySet = new Set(keptMandatory);
  const candidates = Array.from({ length: input.rowCount }, (_, index) => index).filter(
    (index) => !mandatorySet.has(index),
  );
  return [...keptMandatory, ...evenlySample(candidates, remaining)].sort(
    (left, right) => left - right,
  );
}

export function findNearestMinimapMarkerIndex(
  markerRowIndices: ReadonlyArray<number>,
  targetRowIndex: number,
): number {
  if (markerRowIndices.length === 0) return -1;
  let low = 0;
  let high = markerRowIndices.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = markerRowIndices[middle]!;
    if (value === targetRowIndex) return middle;
    if (value < targetRowIndex) low = middle + 1;
    else high = middle - 1;
  }
  if (low >= markerRowIndices.length) return markerRowIndices.length - 1;
  if (high < 0) return 0;
  return targetRowIndex - markerRowIndices[high]! <= markerRowIndices[low]! - targetRowIndex
    ? high
    : low;
}

export function resolveActiveTurnRailIndex(
  markerRowIndices: ReadonlyArray<number>,
  activeRowIndex: number,
): number {
  const nearest = findNearestMinimapMarkerIndex(markerRowIndices, activeRowIndex);
  if (nearest < 0) return -1;
  return markerRowIndices[nearest]! > activeRowIndex && nearest > 0 ? nearest - 1 : nearest;
}

export const TIMELINE_TURN_RAIL_ITEM_SPACING = 8;
export const TIMELINE_TURN_RAIL_MIN_ITEMS = 2;
export const TIMELINE_TURN_RAIL_PERSISTENT_GUTTER = 48;
export const TIMELINE_TURN_RAIL_HIT_STRIP_LEFT = 4;
export const TIMELINE_TURN_RAIL_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_TURN_RAIL_EXPANDED_HIT_STRIP_WIDTH = "22rem";

export function resolveTimelineTurnRailHasPersistentGutter(gutterPx: number): boolean {
  return Number.isFinite(gutterPx) && gutterPx >= TIMELINE_TURN_RAIL_PERSISTENT_GUTTER;
}

export function resolveTimelineTurnRailHitStripWidth(gutterPx: number): number {
  if (!Number.isFinite(gutterPx)) return 0;
  return Math.max(
    0,
    Math.min(
      TIMELINE_TURN_RAIL_HIT_STRIP_MAX_WIDTH,
      Math.floor(gutterPx) - TIMELINE_TURN_RAIL_HIT_STRIP_LEFT,
    ),
  );
}

export function resolveTimelineTurnRailHeightStyle(itemCount: number): string {
  return `min(${Math.max(1, (itemCount - 1) * TIMELINE_TURN_RAIL_ITEM_SPACING)}px, 100%)`;
}

export function resolveTimelineTurnRailTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) return 0;
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineTurnRailIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) return null;
  if (input.itemCount === 1) return 0;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineTurnRailInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_TURN_RAIL_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

export interface TimelineTurnRailRowSource {
  readonly id: string;
  readonly kind: string;
  readonly createdAt?: string | null;
  readonly message?: {
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<{ readonly name: string }>;
  };
}

export interface TimelineTurnRailItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly createdAt: string | null;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

/** Previews read at most this much of a message, so long responses stay cheap. */
export const TURN_RAIL_PREVIEW_SOURCE_CHARS = 4_096;
/** Displayed previews are cut to this many characters. */
export const TURN_RAIL_PREVIEW_DISPLAY_CHARS = 240;

function compactTurnRailPreview(value: string | null | undefined): string | null {
  const compacted =
    value?.slice(0, TURN_RAIL_PREVIEW_SOURCE_CHARS).replace(/\s+/g, " ").trim() ?? "";
  if (compacted.length === 0) return null;
  return compacted.length > TURN_RAIL_PREVIEW_DISPLAY_CHARS
    ? `${compacted.slice(0, TURN_RAIL_PREVIEW_DISPLAY_CHARS - 1).trimEnd()}…`
    : compacted;
}

// Previews per message object: a message is immutable, and streaming replaces it.
const userPreviewCache = new WeakMap<object, string | null>();
const assistantPreviewCache = new WeakMap<object, string | null>();

function cachedPreview(
  cache: WeakMap<object, string | null>,
  message: NonNullable<TimelineTurnRailRowSource["message"]>,
  derive: () => string | null,
): string | null {
  if (cache.has(message)) return cache.get(message)!;
  const preview = derive();
  cache.set(message, preview);
  return preview;
}

function summarizeNames(names: ReadonlyArray<string>): string | null {
  const nonempty = names.map((name) => name.trim()).filter(Boolean);
  if (nonempty.length === 0) return null;
  const shown = nonempty.slice(0, 3).join(", ");
  return nonempty.length > 3 ? `${shown} +${nonempty.length - 3} more` : shown;
}

function resolveTurnRailUserPreview(
  message: NonNullable<TimelineTurnRailRowSource["message"]>,
): string | null {
  const attached = extractTrailingAttachedFiles(message.text);
  const terminal = extractTrailingTerminalContexts(attached.promptText);
  return (
    compactTurnRailPreview(terminal.promptText) ??
    summarizeNames(attached.filePaths.map((path) => path.split(/[\\/]/).at(-1) ?? path)) ??
    summarizeNames(message.attachments?.map(({ name }) => name) ?? []) ??
    compactTurnRailPreview(terminal.previewTitle)
  );
}

/**
 * One item per user turn, with its prompt and the turn's final assistant
 * text as plain-text previews. A single forward pass; previews are cached per
 * message, so a streaming delta only recomputes the message it replaced.
 */
export function deriveTimelineTurnRailItems(
  rows: ReadonlyArray<TimelineTurnRailRowSource>,
): TimelineTurnRailItem[] {
  const items: TimelineTurnRailItem[] = [];
  let current: {
    id: string;
    rowIndex: number;
    createdAt: string | null;
    userText: string | null;
    assistantText: string | null;
  } | null = null;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const message = row.kind === "message" ? row.message : undefined;
    if (!message) continue;
    if (message.role === "user") {
      if (current) items.push(current);
      current = {
        id: row.id,
        rowIndex,
        createdAt: row.createdAt ?? null,
        userText: cachedPreview(userPreviewCache, message, () =>
          resolveTurnRailUserPreview(message),
        ),
        assistantText: null,
      };
    } else if (message.role === "assistant" && current) {
      current.assistantText = cachedPreview(assistantPreviewCache, message, () =>
        compactTurnRailPreview(message.text),
      );
    }
  }
  if (current) items.push(current);
  return items;
}

export function resolveCodexCollaborationHeading(
  tool: CodexCollaborationTool,
  status: RuntimeItemStatus | undefined,
  receiverCount: number,
): string {
  const failed = status === "failed" || status === "declined";
  if (failed) {
    return {
      spawnAgent: "Agent spawn failed",
      sendInput: "Message delivery failed",
      resumeAgent: "Agent resume failed",
      wait: "Agent wait failed",
      closeAgent: "Agent close failed",
    }[tool];
  }
  const completed = status === "completed";
  const target =
    receiverCount > 0 ? `${receiverCount} ${receiverCount === 1 ? "agent" : "agents"}` : null;
  switch (tool) {
    case "spawnAgent":
      return completed ? "Spawned agent" : "Spawning agent";
    case "sendInput":
      if (!target) return completed ? "Sent message" : "Sending message";
      return `${completed ? "Sent message to" : "Sending message to"} ${target}`;
    case "resumeAgent":
      return completed ? "Resumed agent" : "Resuming agent";
    case "wait":
      return completed
        ? "Finished waiting"
        : target
          ? `Waiting for ${target}`
          : "Waiting for agents";
    case "closeAgent":
      return completed ? "Closed agent" : "Closing agent";
  }
}

export function resolveCodexCollaborationStatusLabel(
  status: CodexCollaborationAgentStatus,
): string {
  return {
    pendingInit: "Pending",
    running: "Running",
    interrupted: "Interrupted",
    completed: "Completed",
    errored: "Errored",
    shutdown: "Shut down",
    notFound: "Not found",
  }[status];
}

export function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** The working row's label: `Working · 12s`, or `Working…` before the turn has a start. */
export function formatWorkingLabel(createdAt: string | null, nowIso: string): string {
  return createdAt ? `Working · ${formatWorkingTimer(createdAt, nowIso) ?? "0s"}` : "Working…";
}

/** How long a newly appended row keeps its entrance animation. */
export const ROW_ARRIVAL_DURATION_MS = 600;

export interface RowArrivalState {
  readonly threadId: string | null;
  readonly knownIds: ReadonlySet<string>;
  /** The id list `knownIds` was built from; an identical list skips the diff. */
  readonly rowIds?: ReadonlyArray<string>;
  readonly followNextTailNonce: number;
  /** Entering row ids and when their animation ends. */
  readonly entering: ReadonlyMap<string, number>;
}

/**
 * Which rows play the entrance animation. A thread's first rows (its loaded
 * history) are a baseline that never animates, and neither does history
 * prepended above it. A row appended below the first known row enters only
 * while a turn is working or right after a send asked the list to follow the
 * tail, so an idle second batch of loaded history stays still.
 */
export function advanceRowArrivals(
  previous: RowArrivalState | null,
  input: {
    readonly threadId: string | null;
    readonly rowIds: ReadonlyArray<string>;
    readonly isWorking: boolean;
    readonly followNextTailNonce: number;
    readonly now: number;
  },
): RowArrivalState {
  if (!previous || previous.threadId !== input.threadId) {
    return {
      threadId: input.threadId,
      knownIds: new Set(input.rowIds),
      rowIds: input.rowIds,
      followNextTailNonce: input.followNextTailNonce,
      entering: new Map(),
    };
  }
  // Called on every render: an unchanged (memoized) id list with nothing to
  // expire returns without rebuilding any sets.
  if (
    previous.rowIds === input.rowIds &&
    input.followNextTailNonce === previous.followNextTailNonce &&
    [...previous.entering.values()].every((expiresAt) => expiresAt > input.now)
  ) {
    return previous;
  }
  // New rows above the first known row are prepended history. Appended rows
  // can land before a trailing row such as the working indicator, so anything
  // new below the first known row counts as appended.
  const firstKnownIndex =
    previous.knownIds.size === 0 ? -1 : input.rowIds.findIndex((id) => previous.knownIds.has(id));
  const followed = input.followNextTailNonce !== previous.followNextTailNonce;
  const admitsArrivals = input.isWorking || followed;
  const present = new Set(input.rowIds);
  let changed =
    followed ||
    present.size !== previous.knownIds.size ||
    input.rowIds.some((id) => !previous.knownIds.has(id));
  const entering = new Map<string, number>();
  for (const [id, expiresAt] of previous.entering) {
    if (expiresAt > input.now && present.has(id)) entering.set(id, expiresAt);
    else changed = true;
  }
  // Every known row gone (a rewind or reload) leaves nothing to append below.
  if (admitsArrivals && (previous.knownIds.size === 0 || firstKnownIndex !== -1)) {
    for (const id of input.rowIds.slice(firstKnownIndex + 1)) {
      if (previous.knownIds.has(id)) continue;
      entering.set(id, input.now + ROW_ARRIVAL_DURATION_MS);
      changed = true;
    }
  }
  if (!changed) return previous;
  return {
    threadId: input.threadId,
    knownIds: present,
    rowIds: input.rowIds,
    followNextTailNonce: input.followNextTailNonce,
    entering,
  };
}

/** What the "Jump to latest" pill compares against while the reader is away. */
export interface TimelineTailSnapshot {
  readonly rowId: string | null;
  /** Streaming provenance of the tail message's text, when it has one. */
  readonly textEpoch: object | null;
  readonly textRevision: number | null;
  /** The tail message's text, compared by identity when there is no provenance. */
  readonly text: string | null;
}

/**
 * Content that arrived since `baseline`: a new tail row, or more text in the
 * same tail message. Anything else (an elapsed-time tick) is no change.
 */
export function classifyTimelineTailChange(
  baseline: TimelineTailSnapshot,
  current: TimelineTailSnapshot,
): "new-messages" | "response-updated" | null {
  if (current.rowId !== baseline.rowId) return current.rowId === null ? null : "new-messages";
  if (current.textEpoch !== null || baseline.textEpoch !== null) {
    if (current.textEpoch !== baseline.textEpoch) return "response-updated";
    return (current.textRevision ?? 0) > (baseline.textRevision ?? 0) ? "response-updated" : null;
  }
  return current.text !== baseline.text ? "response-updated" : null;
}

export function deriveCodexCollaborationResponseRows(
  receiverThreadIds: ReadonlyArray<string>,
  states: ReadonlyArray<CompactSubagentState>,
): CompactSubagentState[] {
  const byThreadId = new Map(states.map((state) => [state.threadId, state]));
  return receiverThreadIds.flatMap((threadId) => {
    const state = byThreadId.get(threadId);
    return state ? [state] : [];
  });
}
