import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  normalizeComposerMentions,
  reconcileComposerMentions,
  type ComposerMention,
  filterComposerTerminalPlaceholders,
} from "./composer-editor-mentions";

interface MentionHistoryEntry {
  threadId: string;
  messageId: string;
  prompt: string;
  mentions: readonly ComposerMention[];
}

/** Local provenance only. Messages received from another client remain literal. */
export const useComposerMentionHistoryStore = create<{
  entries: MentionHistoryEntry[];
  remember: (entry: MentionHistoryEntry) => void;
}>()(
  persist(
    (set) => ({
      entries: [],
      remember: (entry) =>
        set((state) => ({
          entries: [
            entry,
            ...state.entries.filter(
              (previous) =>
                previous.threadId !== entry.threadId || previous.messageId !== entry.messageId,
            ),
          ].slice(0, 200),
        })),
    }),
    {
      name: "f5:composer-mention-history:v1",
      // History is best effort: storage quota or privacy settings must never block sending.
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return localStorage.getItem(key);
          } catch {
            return null;
          }
        },
        setItem: (key, value) => {
          try {
            localStorage.setItem(key, value);
          } catch {
            /* Keep in memory. */
          }
        },
        removeItem: (key) => {
          try {
            localStorage.removeItem(key);
          } catch {
            /* Keep in memory. */
          }
        },
      })),
      partialize: (state) => ({ entries: state.entries }),
      merge: (persisted, current) => {
        const entries = (persisted as { entries?: unknown } | null)?.entries;
        return {
          ...current,
          entries: Array.isArray(entries)
            ? entries
                .flatMap((entry) => {
                  if (
                    !entry ||
                    typeof entry.threadId !== "string" ||
                    typeof entry.messageId !== "string" ||
                    typeof entry.prompt !== "string"
                  )
                    return [];
                  return [
                    {
                      threadId: entry.threadId,
                      messageId: entry.messageId,
                      prompt: entry.prompt,
                      mentions: normalizeComposerMentions(entry.prompt, entry.mentions),
                    },
                  ];
                })
                .slice(0, 200)
            : [],
        };
      },
    },
  ),
);

export function recallComposerMentions(threadId: string, messageId: string, prompt: string) {
  const entry = useComposerMentionHistoryStore
    .getState()
    .entries.find(
      (candidate) => candidate.threadId === threadId && candidate.messageId === messageId,
    );
  if (!entry) return [];
  const filtered = filterComposerTerminalPlaceholders(entry.prompt, entry.mentions, []);
  const leftTrimmed = filtered.prompt.trimStart();
  const leftMentions = reconcileComposerMentions(filtered.prompt, leftTrimmed, filtered.mentions);
  const trimmed = leftTrimmed.trimEnd();
  const trimmedMentions = reconcileComposerMentions(leftTrimmed, trimmed, leftMentions);
  return reconcileComposerMentions(trimmed, prompt, trimmedMentions);
}
