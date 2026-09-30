import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
  materializeComposerPrompt,
  normalizeComposerMentions,
  reconcileComposerMentions,
  type ComposerMention,
} from "./composer-editor-mentions";
import { deriveDisplayedUserMessageState, type TerminalContextDraft } from "./lib/terminalContext";
import { recallablePromptWithMentions } from "./components/chat/composer/promptHistory";

export const COMPOSER_MENTION_HISTORY_STORAGE_KEY = "f5:composer-mention-history:v1";
export const MAX_MENTION_HISTORY_BYTES = 128 * 1024;
const MAX_HISTORY_ENTRIES = 200;
export interface MentionHistoryEntry {
  threadId: string;
  messageId: string;
  promptLength: number;
  mentions: readonly ComposerMention[];
}
/** Full prompt text is used transiently and never stored in history. */
export function createMentionHistoryEntry(input: {
  threadId: string;
  messageId: string;
  prompt: string;
  mentions: readonly ComposerMention[];
  terminalContexts: readonly TerminalContextDraft[];
  messageText: string;
}): MentionHistoryEntry {
  const materialized = materializeComposerPrompt(
    input.prompt,
    input.mentions,
    input.terminalContexts,
  );
  const visible = deriveDisplayedUserMessageState(input.messageText).visibleText;
  const sentMentions = reconcileComposerMentions(
    materialized.prompt,
    visible,
    materialized.mentions,
  );
  const recalled = recallablePromptWithMentions(input.messageText, sentMentions);
  return {
    threadId: input.threadId,
    messageId: input.messageId,
    promptLength: recalled.prompt.length,
    mentions: recalled.mentions,
  };
}
/** Conservative UTF-16 accounting, including the persistence envelope. */
export function mentionHistoryBytes(entries: readonly MentionHistoryEntry[]): number {
  return JSON.stringify({ state: { entries }, version: 2 }).length * 2;
}
function boundedEntries(input: unknown): MentionHistoryEntry[] {
  if (!Array.isArray(input)) return [];
  const result: MentionHistoryEntry[] = [];
  const keys = new Set<string>();
  for (const value of input.slice(0, MAX_HISTORY_ENTRIES)) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.threadId !== "string" ||
      typeof value.messageId !== "string" ||
      !Number.isSafeInteger(value.promptLength) ||
      value.promptLength < 0 ||
      !Array.isArray(value.mentions)
    )
      continue;
    // Copy only known fields: legacy entries contained complete prompts.
    const mentions: ComposerMention[] = value.mentions.flatMap((mention: unknown) => {
      if (!mention || typeof mention !== "object") return [];
      const { id, path, start, end } = mention as ComposerMention;
      if (
        typeof id !== "string" ||
        typeof path !== "string" ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > value.promptLength
      )
        return [];
      return [{ id, path, start, end }];
    });
    if (mentions.length === 0) continue;
    const entry = {
      threadId: value.threadId,
      messageId: value.messageId,
      promptLength: value.promptLength,
      mentions,
    };
    const key = JSON.stringify([entry.threadId, entry.messageId]);
    if (keys.has(key) || mentionHistoryBytes([...result, entry]) > MAX_MENTION_HISTORY_BYTES)
      continue;
    result.push(entry);
    keys.add(key);
  }
  return result;
}
/** Evict persisted history on quota failure to leave space for the user's draft. */
export function mentionHistoryStorage(
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">,
): StateStorage {
  return {
    getItem: (key) => {
      try {
        return storage().getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        storage().setItem(key, value);
      } catch {
        try {
          storage().removeItem(key);
        } catch {
          /* Storage may be unavailable. */
        }
      }
    },
    removeItem: (key) => {
      try {
        storage().removeItem(key);
      } catch {
        /* Unavailable storage. */
      }
    },
  };
}
/** Local provenance only. Messages received from another client remain literal. */
export const useComposerMentionHistoryStore = create<{
  entries: MentionHistoryEntry[];
  remember: (entry: MentionHistoryEntry) => void;
  forgetThread: (threadId: string) => void;
  retainThreads: (threadIds: ReadonlySet<string>) => void;
}>()(
  persist(
    (set) => ({
      entries: [],
      remember: (entry) =>
        set((state) => ({
          entries: boundedEntries([
            entry,
            ...state.entries.filter(
              (previous) =>
                previous.threadId !== entry.threadId || previous.messageId !== entry.messageId,
            ),
          ]),
        })),
      forgetThread: (threadId) =>
        set((state) => ({ entries: state.entries.filter((entry) => entry.threadId !== threadId) })),
      retainThreads: (threadIds) =>
        set((state) => ({
          entries: state.entries.filter((entry) => threadIds.has(entry.threadId)),
        })),
    }),
    {
      name: COMPOSER_MENTION_HISTORY_STORAGE_KEY,
      version: 2,
      // Hydration overwrites legacy prompt bodies with empty metadata.
      migrate: () => ({ entries: [] }),
      storage: createJSONStorage(() => mentionHistoryStorage(() => localStorage)),
      partialize: (state) => ({ entries: boundedEntries(state.entries) }),
      merge: (persisted, current) => ({
        ...current,
        entries: boundedEntries((persisted as { entries?: unknown } | null)?.entries),
      }),
    },
  ),
);
export function recallComposerMentions(threadId: string, messageId: string, prompt: string) {
  const entry = useComposerMentionHistoryStore
    .getState()
    .entries.find(
      (candidate) => candidate.threadId === threadId && candidate.messageId === messageId,
    );
  return entry?.promptLength === prompt.length
    ? normalizeComposerMentions(prompt, entry.mentions)
    : [];
}
