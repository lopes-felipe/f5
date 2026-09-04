import type {
  CodexCollaborationAgentStatus,
  CodexCollaborationTool,
  CompactSubagentState,
  RuntimeItemStatus,
} from "@t3tools/contracts";

import { extractTrailingAttachedFiles } from "../../lib/attachedFiles";
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
export const TIMELINE_TURN_RAIL_HIT_STRIP_LEFT = 12;
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
  readonly message?: {
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly attachments?: ReadonlyArray<{ readonly name: string }>;
  };
}

export interface TimelineTurnRailItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

function compactTurnRailPreview(value: string | null | undefined): string | null {
  const compacted = value?.replace(/\s+/g, " ").trim() ?? "";
  return compacted.length > 0 ? compacted : null;
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

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<TimelineTurnRailRowSource>,
  userRowIndex: number,
): string | null {
  let assistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind !== "message" || !row.message) continue;
    if (row.message.role === "user") break;
    if (row.message.role === "assistant") assistantText = compactTurnRailPreview(row.message.text);
  }
  return assistantText;
}

export function deriveTimelineTurnRailItems(
  rows: ReadonlyArray<TimelineTurnRailRowSource>,
): TimelineTurnRailItem[] {
  const items: TimelineTurnRailItem[] = [];
  rows.forEach((row, rowIndex) => {
    if (row.kind !== "message" || row.message?.role !== "user") return;
    items.push({
      id: row.id,
      rowIndex,
      userText: resolveTurnRailUserPreview(row.message),
      assistantText: resolveFinalAssistantTextForTurn(rows, rowIndex),
    });
  });
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
