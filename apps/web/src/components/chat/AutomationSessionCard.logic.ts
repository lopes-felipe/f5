import {
  COMPUTER_ACTION_VERB,
  PREVIEW_ACTION_VERB,
  automationToolSurface,
  computerToolHeading,
  computerToolOp,
  previewToolHeading,
  previewToolOp,
  type AutomationToolSurface,
} from "@t3tools/shared/computerAction";
import { formatElapsed, type WorkLogEntry } from "../../session-logic";

export type AutomationSurface = AutomationToolSurface;
export type AutomationRunStatus = "running" | "failed" | "done";

type Entry = Pick<
  WorkLogEntry,
  | "id"
  | "createdAt"
  | "tone"
  | "label"
  | "detail"
  | "status"
  | "itemType"
  | "mcpServerName"
  | "mcpToolName"
  | "computerTool"
  | "computerStep"
  | "mcpInput"
  | "mcpImages"
  | "mcpImagesOmitted"
  | "mcpApp"
  | "htmlRender"
>;

/** Entries with their own embedded UI keep their normal rows instead of joining a card. */
export function classifyAutomationEntry(
  entry: Pick<
    Entry,
    "computerTool" | "itemType" | "mcpServerName" | "mcpToolName" | "mcpApp" | "htmlRender"
  >,
): AutomationSurface | undefined {
  if (entry.mcpApp || entry.htmlRender) return undefined;
  return automationToolSurface(entry);
}

/**
 * A call is live only while its turn is. An idle turn's leftover in-progress snapshot is a
 * lost completion (interrupt, crash), not a running action.
 */
export function isAutomationEntryRunning(entry: Pick<Entry, "status">, active: boolean): boolean {
  return active && entry.status === "inProgress";
}

function isAutomationEntryInterrupted(entry: Pick<Entry, "status">, active: boolean): boolean {
  return !active && entry.status === "inProgress";
}

export function automationEntryOp(entry: Entry): string | undefined {
  return classifyAutomationEntry(entry) === "computer"
    ? computerToolOp(entry.mcpToolName)
    : previewToolOp(entry.mcpServerName, entry.mcpToolName);
}

/**
 * End index (exclusive) of the automation run starting at `start`. Thinking entries
 * between same-surface calls stay in the run; trailing ones are left for the next row.
 */
export function automationRunEnd<T>(
  items: ReadonlyArray<T>,
  start: number,
  readEntry: (item: T) => Entry | undefined,
): number {
  const first = readEntry(items[start]!);
  const surface = first ? classifyAutomationEntry(first) : undefined;
  if (!surface) return start + 1;
  let end = start + 1;
  for (let cursor = start + 1; cursor < items.length; cursor += 1) {
    const entry = readEntry(items[cursor]!);
    if (!entry) break;
    if (classifyAutomationEntry(entry) === surface) end = cursor + 1;
    else if (entry.tone !== "thinking") break;
  }
  return end;
}

export function isAutomationEntryFailed(entry: Pick<Entry, "status" | "tone">): boolean {
  return entry.status === "failed" || entry.tone === "error";
}

export function automationStepHeading(entry: Entry, active = true): string {
  if (isAutomationEntryInterrupted(entry, active)) {
    const verb = automationVerbs(entry)?.[0];
    if (verb) return `${verb} interrupted`;
  }
  const status = isAutomationEntryFailed(entry) ? "failed" : entry.status;
  return (
    (classifyAutomationEntry(entry) === "computer"
      ? computerToolHeading(entry.mcpToolName, status)
      : previewToolHeading(entry.mcpToolName, status)) ?? entry.label
  );
}

function automationVerbs(entry: Entry): readonly [string, string] | undefined {
  const op = automationEntryOp(entry);
  if (!op) return undefined;
  return classifyAutomationEntry(entry) === "computer"
    ? COMPUTER_ACTION_VERB[op]
    : PREVIEW_ACTION_VERB[op];
}

function parseInput(entry: Entry): Record<string, unknown> | undefined {
  if (!entry.mcpInput?.trimStart().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(entry.mcpInput);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function previewUrlLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return truncate(`${url.host}${path}`, 60);
  } catch {
    return truncate(value, 60);
  }
}

function previewTarget(input: Record<string, unknown>): string | undefined {
  if (typeof input.selector === "string" && input.selector) return truncate(input.selector, 48);
  const locator = input.locator;
  if (locator && typeof locator === "object") {
    const { role, name } = locator as Record<string, unknown>;
    if (typeof name === "string" && name)
      return truncate(typeof role === "string" ? `${role} “${name}”` : `“${name}”`, 48);
  }
  if (typeof input.x === "number" && typeof input.y === "number")
    return `${Math.round(input.x)}, ${Math.round(input.y)}`;
  return undefined;
}

/** Secondary text for a step: target, keys, counts and outcome. Never typed text. */
export function automationStepDetail(entry: Entry): string | undefined {
  const parts: string[] = [];
  if (classifyAutomationEntry(entry) === "computer") {
    const step = entry.computerStep;
    if (!step) return undefined;
    if (step.appName) parts.push(step.appName);
    if (step.x !== undefined && step.y !== undefined) parts.push(`${step.x}, ${step.y}`);
    if (step.keyChord) parts.push(step.repeat ? `${step.keyChord} ×${step.repeat}` : step.keyChord);
    if (step.typedLength !== undefined) parts.push(plural(step.typedLength, "character"));
    if (step.outcome) parts.push(step.outcome);
  } else {
    const input = parseInput(entry);
    if (!input) return undefined;
    switch (automationEntryOp(entry)) {
      case "navigate":
      case "open": {
        const url = previewUrlLabel(input.url);
        if (url) parts.push(url);
        break;
      }
      case "click":
      case "wait_for": {
        const target = previewTarget(input);
        if (target) parts.push(target);
        break;
      }
      case "type":
        if (typeof input.text === "string") parts.push(plural([...input.text].length, "character"));
        break;
      case "press":
        if (typeof input.key === "string") {
          const modifiers = Array.isArray(input.modifiers)
            ? input.modifiers.filter((modifier) => typeof modifier === "string")
            : [];
          parts.push(truncate([...modifiers, input.key].join("+"), 48));
        }
        break;
      case "viewport":
        if (typeof input.width === "number" && typeof input.height === "number")
          parts.push(`${input.width}×${input.height}`);
        break;
    }
  }
  return parts.length ? parts.join(" · ") : undefined;
}

export interface AutomationChip {
  readonly key: string;
  readonly op: string;
  readonly count: number;
  readonly failed: boolean;
  readonly running: boolean;
  readonly title: string;
}

export const AUTOMATION_CHIP_LIMIT = 24;

/** Consecutive same-op, same-status calls share one chip; the strip keeps the newest chips. */
export function coalesceAutomationChips(
  entries: ReadonlyArray<Entry>,
  limit = AUTOMATION_CHIP_LIMIT,
  active = true,
): { chips: AutomationChip[]; hiddenCount: number } {
  const chips: AutomationChip[] = [];
  for (const entry of entries) {
    const op = automationEntryOp(entry);
    if (!op) continue;
    const failed = isAutomationEntryFailed(entry);
    const running = isAutomationEntryRunning(entry, active);
    const previous = chips.at(-1);
    if (
      previous &&
      previous.op === op &&
      previous.failed === failed &&
      !running &&
      !previous.running
    ) {
      chips[chips.length - 1] = { ...previous, count: previous.count + 1 };
      continue;
    }
    chips.push({
      key: entry.id,
      op,
      count: 1,
      failed,
      running,
      title: automationStepHeading(entry, active),
    });
  }
  const hidden = chips.slice(0, Math.max(0, chips.length - limit));
  return {
    chips: chips.slice(-limit),
    hiddenCount: hidden.reduce((sum, chip) => sum + chip.count, 0),
  };
}

export interface AutomationRunImage {
  readonly attachmentId: string;
  readonly mimeType: string;
}

export interface AutomationRun {
  readonly surface: AutomationSurface;
  readonly title: string;
  readonly actionCount: number;
  readonly failedCount: number;
  readonly status: AutomationRunStatus;
  readonly duration: string | null;
  readonly chips: AutomationChip[];
  readonly hiddenChipCount: number;
  readonly images: AutomationRunImage[];
  readonly omittedImageCount: number;
}

function ongoingVerb(surface: AutomationSurface, entry: Entry): string | undefined {
  const op = automationEntryOp(entry);
  const words = op
    ? surface === "computer"
      ? COMPUTER_ACTION_VERB[op]
      : PREVIEW_ACTION_VERB[op]
    : undefined;
  return words ? `${words[0]}…` : undefined;
}

function runTitle(
  surface: AutomationSurface,
  actions: ReadonlyArray<Entry>,
  status: AutomationRunStatus,
): string {
  const latest = actions.at(-1);
  if (surface === "computer") {
    const apps = [
      ...new Set(
        actions.flatMap((entry) =>
          entry.computerStep?.appName ? [entry.computerStep.appName] : [],
        ),
      ),
    ];
    if (status === "running" && latest) {
      const verb = ongoingVerb(surface, latest) ?? "Using the computer…";
      const app = latest.computerStep?.appName ?? apps.at(-1);
      return app ? `${verb} · ${app}` : verb;
    }
    if (apps.length === 0) return "Used the computer";
    const named = apps.slice(0, 2).join(", ");
    return apps.length > 2 ? `Used ${named} +${apps.length - 2}` : `Used ${named}`;
  }
  let host: string | undefined;
  for (const entry of actions) {
    const op = automationEntryOp(entry);
    if (op !== "navigate" && op !== "open") continue;
    const url = parseInput(entry)?.url;
    if (typeof url !== "string") continue;
    try {
      host = new URL(url).host || host;
    } catch {
      // Unparseable targets keep the last good host.
    }
  }
  if (status === "running" && latest) {
    const verb = ongoingVerb(surface, latest) ?? "Using the browser preview…";
    return host ? `${verb} · ${host}` : verb;
  }
  return host ? `Used browser preview · ${host}` : "Used browser preview";
}

/** `active`: the run belongs to the turn that is still working. */
export function buildAutomationRun(
  surface: AutomationSurface,
  entries: ReadonlyArray<Entry>,
  active = true,
): AutomationRun {
  const actions = entries.filter((entry) => classifyAutomationEntry(entry) === surface);
  const failedCount = actions.filter(isAutomationEntryFailed).length;
  const latest = actions.at(-1);
  const status: AutomationRunStatus = actions.some((entry) =>
    isAutomationEntryRunning(entry, active),
  )
    ? "running"
    : latest && isAutomationEntryFailed(latest)
      ? "failed"
      : "done";
  const first = actions[0];
  const duration =
    first && latest && first !== latest ? formatElapsed(first.createdAt, latest.createdAt) : null;
  const { chips, hiddenCount } = coalesceAutomationChips(actions, AUTOMATION_CHIP_LIMIT, active);
  const images = actions.flatMap((entry) =>
    (entry.mcpImages ?? []).map((image) => ({
      attachmentId: image.attachmentId,
      mimeType: image.mimeType,
    })),
  );
  return {
    surface,
    title: runTitle(surface, actions, status),
    actionCount: actions.length,
    failedCount,
    status,
    duration,
    chips,
    hiddenChipCount: hiddenCount,
    images,
    omittedImageCount: actions.reduce((sum, entry) => sum + (entry.mcpImagesOmitted ?? 0), 0),
  };
}

/** One-line summary used when a finished turn's work collapses. */
export function summarizeAutomationRun(
  surface: AutomationSurface,
  entries: ReadonlyArray<Entry>,
  active = true,
): string {
  const run = buildAutomationRun(surface, entries, active);
  const parts = [run.title, plural(run.actionCount, "action")];
  if (run.failedCount) parts.push(`${run.failedCount} failed`);
  return parts.join(" · ");
}
