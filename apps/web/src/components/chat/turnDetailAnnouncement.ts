import type { ScreenReaderAnnouncements } from "../../appSettings";
import type { TimelineEntry } from "../../session-logic";
import { stripMarkdownToPlainText } from "../sidebar/sidebarPeek";

export interface TurnDetail {
  readonly tailId: string | null;
  readonly entryIds: readonly string[];
  readonly activity: string | null;
  readonly messages: ReadonlyArray<{ id: string; text: string; finished: boolean }>;
}

/** Inspect only the current turn, before timeline visibility hides tools. */
export function turnDetail(entries: readonly TimelineEntry[], turnId: string | null): TurnDetail {
  const messages: Array<{ id: string; text: string; finished: boolean }> = [];
  const entryIds: string[] = [];
  let continued = false;
  let activity: string | null | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    entryIds.push(entry.id);
    if (entry.kind === "message") {
      if (entry.message.role === "user") break;
      if (entry.message.turnId !== turnId || entry.message.role !== "assistant") continue;
      if (activity === undefined) activity = null;
      messages.push({
        id: entry.id,
        text: entry.message.text,
        finished: !entry.message.streaming && continued,
      });
      continued = true;
    } else if (entry.kind === "work" && entry.entry.turnId === turnId) {
      const work = entry.entry;
      if (work.tone !== "tool" && work.tone !== "thinking") continue;
      continued = true;
      // Approval/question text already belongs to the status announcer.
      if (work.requestKind !== undefined || work.userInput !== undefined) continue;
      if (activity === undefined)
        activity =
          work.tone === "thinking"
            ? "Thinking"
            : work.status === "failed" || work.status === "declined"
              ? null
              : work.label.replace(/\s+/g, " ").trim().slice(0, 120) || null;
    } else if (entry.kind === "command" && entry.commandExecution.turnId === turnId) {
      continued = true;
      const command = entry.commandExecution;
      if (activity === undefined)
        activity =
          command.status === "failed" || command.status === "declined"
            ? null
            : (command.description ?? command.title ?? command.command)
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120);
    }
  }
  return {
    messages: messages.reverse(),
    entryIds: entryIds.reverse(),
    activity: activity ?? null,
    tailId: entries.at(-1)?.id ?? null,
  };
}

export interface TurnDetailMemory extends TurnDetail {
  readonly level: ScreenReaderAnnouncements;
}
export const EMPTY_TURN_DETAIL: TurnDetail = {
  entryIds: [],
  tailId: null,
  messages: [],
  activity: null,
};

/** A new thread/turn or setting establishes a silent baseline; loaded history never replays. */
export function nextTurnDetailAnnouncement(
  previous: TurnDetailMemory | null,
  detail: TurnDetail,
  level: ScreenReaderAnnouncements,
  active: boolean,
  working = active,
) {
  const memory: TurnDetailMemory = { ...detail, level, activity: working ? detail.activity : null };
  if (previous === null || previous.level !== level || level === "status" || !active)
    return { memory, messages: [] as string[], activity: null };
  const known = new Map(previous.messages.map((message) => [message.id, message.finished]));
  const previousTail = previous.tailId === null ? -1 : detail.entryIds.indexOf(previous.tailId);
  const messages = detail.messages
    .filter(
      (message) =>
        message.finished &&
        (known.get(message.id) === false ||
          (!known.has(message.id) &&
            previousTail >= 0 &&
            detail.entryIds.indexOf(message.id) > previousTail)),
    )
    .map((message) => stripMarkdownToPlainText(message.text.slice(0, 2000)))
    .filter(Boolean)
    .map((text) => `F5: ${text}`);
  return {
    memory,
    messages,
    activity:
      level === "everything" && memory.activity !== previous.activity ? memory.activity : null,
  };
}
