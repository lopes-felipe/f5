import type {
  NativeOperationCommand,
  NativeOperationRecord,
  OrchestrationThreadActivity,
  ThreadBackgroundWorkEntry,
} from "@t3tools/contracts";

import { formatDuration } from "../../session-logic";

export type NativeRuntimeTrayRow =
  | { readonly kind: "suggestion"; readonly id: string; readonly summary: string }
  | {
      readonly kind: "recovery";
      readonly record: NativeOperationRecord;
      /** A cancelled file revert only needs its acknowledgement finished. */
      readonly finishAcknowledgement: boolean;
    }
  | { readonly kind: "running"; readonly record: NativeOperationRecord }
  | { readonly kind: "tasks"; readonly tasks: readonly ThreadBackgroundWorkEntry[] };

export type BackgroundTaskKind = "shell" | "monitor" | "agent" | "workflow";

export interface BackgroundTaskDescription {
  readonly kind: BackgroundTaskKind;
  readonly kindLabel: string;
  readonly title: string;
  /** The agent's own type or path (`Explore`, `/root/reviewer`), when known. */
  readonly agentName: string | null;
  readonly elapsed: string | null;
}

const BACKGROUND_TASK_KINDS: Record<
  BackgroundTaskKind,
  { readonly label: string; readonly fallbackTitle: string }
> = {
  shell: { label: "Shell", fallbackTitle: "Background shell" },
  monitor: { label: "Monitor", fallbackTitle: "Monitor" },
  agent: { label: "Agent", fallbackTitle: "Agent task" },
  workflow: { label: "Workflow", fallbackTitle: "Workflow" },
};

const MAX_TASK_TITLE_LENGTH = 120;

/** Task types that shells report; they never use tools, so `phase` keeps them. */
const SHELL_TASK_TYPES: ReadonlySet<string> = new Set(["local_bash", "shell"]);

/** Raw provider task types that say nothing about which agent is running. */
const GENERIC_AGENT_PHASES: ReadonlySet<string> = new Set([
  ...SHELL_TASK_TYPES,
  "monitor",
  "monitor_mcp",
  "local_agent",
  "remote_agent",
  "subagent",
  "local_workflow",
  "default",
  "plan",
]);

function backgroundTaskKind(
  task: Pick<ThreadBackgroundWorkEntry, "ownership" | "classification" | "phase">,
): BackgroundTaskKind {
  if (task.ownership === "workflow") return "workflow";
  // Rows recorded before the server kept `phase` fixed may carry the last tool
  // name there, so the stable classification decides between shells and
  // agents. Within it, only the shell task types are matched: a monitor whose
  // phase became a tool name stays a monitor.
  if (task.classification === "monitoring") {
    return task.phase !== null && SHELL_TASK_TYPES.has(task.phase) ? "shell" : "monitor";
  }
  return "agent";
}

function backgroundTaskTitle(
  task: Pick<ThreadBackgroundWorkEntry, "latestOutput" | "phase"> & {
    readonly title?: string | null;
  },
): string | null {
  // The title recorded at start is stable; latest output is the fallback for
  // rows recorded before titles were stored.
  const line = (task.title ?? task.latestOutput)
    ?.split("\n")
    // Settled agents report markdown; a heading marker is not part of the name.
    .map((entry) => entry.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)?/, "").trim())
    .find((entry) => entry.length > 0);
  if (!line || line === task.phase) return null;
  return line.length > MAX_TASK_TITLE_LENGTH
    ? `${line.slice(0, MAX_TASK_TITLE_LENGTH - 1).trimEnd()}…`
    : line;
}

/**
 * User-facing name for a background task. The provider's task type
 * (`local_bash`) and internal status (`monitoring`) are not shown.
 */
export function describeBackgroundTask(
  task: Pick<
    ThreadBackgroundWorkEntry,
    "ownership" | "classification" | "phase" | "latestOutput" | "startedAt"
  > & { readonly title?: string | null },
  nowMs: number,
): BackgroundTaskDescription {
  const kind = backgroundTaskKind(task);
  const meta = BACKGROUND_TASK_KINDS[kind];
  const startedAt = Date.parse(task.startedAt);
  const agentName =
    kind === "agent" && task.phase !== null && !GENERIC_AGENT_PHASES.has(task.phase)
      ? task.phase
      : null;
  return {
    kind,
    kindLabel: meta.label,
    title: backgroundTaskTitle(task) ?? agentName ?? meta.fallbackTitle,
    agentName,
    elapsed:
      Number.isNaN(startedAt) || startedAt > nowMs ? null : formatDuration(nowMs - startedAt),
  };
}

const BACKGROUND_KIND_ORDER: ReadonlyArray<BackgroundTaskKind> = [
  "agent",
  "workflow",
  "monitor",
  "shell",
];

/**
 * The background-work status chip: "1 shell", "2 agents · 1 shell", counts
 * by kind with the most counted first. The descriptions are oldest first, so
 * the first elapsed time is the longest.
 */
export function describeBackgroundWorkChip(
  descriptions: ReadonlyArray<Pick<BackgroundTaskDescription, "kind" | "kindLabel" | "elapsed">>,
): { readonly counts: string; readonly elapsed: string | null } {
  const byKind = new Map<BackgroundTaskKind, { label: string; count: number }>();
  for (const description of descriptions) {
    const entry = byKind.get(description.kind);
    if (entry) entry.count += 1;
    else byKind.set(description.kind, { label: description.kindLabel, count: 1 });
  }
  const counts = [...byKind.entries()]
    .toSorted(
      ([leftKind, left], [rightKind, right]) =>
        right.count - left.count ||
        BACKGROUND_KIND_ORDER.indexOf(leftKind) - BACKGROUND_KIND_ORDER.indexOf(rightKind),
    )
    .map(([, { label, count }]) => `${count} ${label.toLowerCase()}${count === 1 ? "" : "s"}`)
    .join(" · ");
  return {
    counts,
    elapsed: descriptions.find((description) => description.elapsed !== null)?.elapsed ?? null,
  };
}

export interface ShellOutputPage {
  readonly output: string;
  readonly totalBytes: number;
  readonly omitted: boolean;
}

/** The bounded output tail a provider returns for a background shell. */
export function readShellOutputPage(page: unknown): ShellOutputPage | null {
  if (!page || typeof page !== "object" || !("entries" in page)) return null;
  const { entries } = page;
  if (!Array.isArray(entries) || entries.length !== 1) return null;
  const entry: unknown = entries[0];
  if (!entry || typeof entry !== "object") return null;
  const { output, totalBytes, omitted } = entry as Record<string, unknown>;
  if (typeof output !== "string" || typeof totalBytes !== "number") return null;
  // The server also cuts the tail to a fixed size without setting `omitted`,
  // so a shorter tail than the reported total means output was cut.
  return {
    output,
    totalBytes,
    omitted: omitted === true || utf8ByteLength(output) < totalBytes,
  };
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Bytes below 1 KB, then whole kilobytes. */
export function formatByteSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** Operation states that still hold the thread's native-operation reservation. */
export function isNativeOperationInFlight(record: Pick<NativeOperationRecord, "state">): boolean {
  return RUNNING_STATES.has(record.state);
}

const RUNNING_STATES: ReadonlySet<NativeOperationRecord["state"]> = new Set([
  "requested",
  "dispatched",
  "running",
]);

const OPERATION_LABELS: Record<NativeOperationCommand["kind"], string> = {
  compact: "Compaction",
  review: "Review",
  stopTask: "Task stop",
  revertFiles: "File revert",
  fork: "Fork",
  goalSet: "Goal start",
  goalPause: "Goal pause",
  goalClear: "Goal clear",
};

export function nativeOperationLabel(kind: NativeOperationCommand["kind"]): string {
  return OPERATION_LABELS[kind];
}

export function latestPromptSuggestion(
  activities: readonly OrchestrationThreadActivity[],
): OrchestrationThreadActivity | undefined {
  return activities.findLast((entry) => entry.kind === "prompt.suggestion");
}

/**
 * Rows worth showing above the composer. Everything informational (model,
 * warnings, goal status) already has a home elsewhere, so an idle thread
 * yields no rows and the tray collapses.
 */
export function selectNativeRuntimeTrayRows(input: {
  readonly activities: readonly OrchestrationThreadActivity[];
  readonly prompt: string;
  readonly latestMessageAt: string | undefined;
  readonly usedSuggestionId: string | null;
  readonly records: readonly NativeOperationRecord[];
  readonly tasks: readonly ThreadBackgroundWorkEntry[];
  readonly canInspectTasks: boolean;
  readonly canStopTasks: boolean;
}): NativeRuntimeTrayRow[] {
  const rows: NativeRuntimeTrayRow[] = [];
  const suggestion = latestPromptSuggestion(input.activities);
  if (
    suggestion &&
    input.usedSuggestionId !== suggestion.id &&
    !input.prompt &&
    (!input.latestMessageAt || suggestion.createdAt > input.latestMessageAt)
  ) {
    rows.push({ kind: "suggestion", id: suggestion.id, summary: suggestion.summary });
  }
  for (const record of input.records) {
    if (record.state === "indeterminate") {
      rows.push({ kind: "recovery", record, finishAcknowledgement: false });
    } else if (record.state === "cancelled" && record.command.kind === "revertFiles") {
      rows.push({ kind: "recovery", record, finishAcknowledgement: true });
    }
  }
  for (const record of input.records) {
    // A started goal stays `running` until it settles, possibly for hours;
    // the header already shows its status.
    if (RUNNING_STATES.has(record.state) && record.command.kind !== "goalSet") {
      rows.push({ kind: "running", record });
    }
  }
  if (input.canInspectTasks || input.canStopTasks) {
    const tasks = input.tasks
      .filter((task) => task.active)
      .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
    if (tasks.length > 0) rows.push({ kind: "tasks", tasks });
  }
  return rows;
}

/**
 * Operations that failed after admission and have not been reported yet:
 * either seen in a non-failed state before, or created while the tray was
 * mounted. Older failures in the server history stay quiet.
 */
export function selectNewlyFailedOperations(input: {
  readonly previous: readonly NativeOperationRecord[];
  readonly next: readonly NativeOperationRecord[];
  readonly mountedAt: string;
  readonly reported: ReadonlySet<string>;
}): NativeOperationRecord[] {
  return input.next.filter(
    (record) =>
      record.state === "failed" &&
      !input.reported.has(record.operationId) &&
      (record.createdAt >= input.mountedAt ||
        input.previous.some(
          (entry) => entry.operationId === record.operationId && entry.state !== "failed",
        )),
  );
}
