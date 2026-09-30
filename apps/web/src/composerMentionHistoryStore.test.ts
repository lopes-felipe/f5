import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { createComposerMention } from "./composer-editor-mentions";
import { appendTerminalContextsToPrompt, type TerminalContextDraft } from "./lib/terminalContext";
import { appendAttachedFilesToPrompt } from "./lib/attachedFiles";
import { recallablePrompt } from "./components/chat/composer/promptHistory";
import {
  COMPOSER_MENTION_HISTORY_STORAGE_KEY,
  MAX_MENTION_HISTORY_BYTES,
  createMentionHistoryEntry,
  mentionHistoryBytes,
  mentionHistoryStorage,
  recallComposerMentions,
  useComposerMentionHistoryStore,
} from "./composerMentionHistoryStore";
import {
  clearAllPendingTurnDispatchArtifacts,
  deletePendingTurnDispatchArtifacts,
  rememberAcceptedTurnMentions,
  setPendingTurnDispatchArtifacts,
  type PendingTurnStartCommand,
} from "./pendingTurnDispatchStore";

const originalStorage = useComposerMentionHistoryStore.persist.getOptions().storage;
beforeEach(() => {
  useComposerMentionHistoryStore.setState({ entries: [] });
  clearAllPendingTurnDispatchArtifacts();
});
afterEach(() => useComposerMentionHistoryStore.persist.setOptions({ storage: originalStorage }));
function context(id: string): TerminalContextDraft {
  return {
    id,
    terminalId: id,
    terminalLabel: "Terminal " + id,
    lineStart: 1,
    lineEnd: 2,
    text: "output",
    threadId: ThreadId.makeUnsafe("t"),
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function historyEntry(messageId = "m", prompt = "Read @src/a.ts and @scope/pkg") {
  return createMentionHistoryEntry({
    threadId: "t",
    messageId,
    prompt,
    mentions: [createComposerMention("src/a.ts", prompt.indexOf("@src/a.ts"))],
    terminalContexts: [],
    messageText: prompt.trim(),
  });
}
it("stores only validated occurrence metadata", () => {
  const prompt = "Read @src/a.ts and @scope/pkg";
  const entry = historyEntry();
  useComposerMentionHistoryStore.getState().remember(entry);
  expect(recallComposerMentions("t", "m", prompt)).toEqual(entry.mentions);
  expect(recallComposerMentions("other", "m", prompt)).toEqual([]);
  expect(recallComposerMentions("t", "old", prompt)).toEqual([]);
  expect(recallComposerMentions("t", "m", prompt + "!")).toEqual([]);
  expect(recallComposerMentions("t", "m", prompt.replace("a.ts", "b.ts"))).toEqual([]);
  expect(JSON.stringify(useComposerMentionHistoryStore.getState())).not.toContain("@scope/pkg");
  const options = useComposerMentionHistoryStore.persist.getOptions();
  expect(
    options.merge!(
      options.partialize!(useComposerMentionHistoryStore.getState()),
      useComposerMentionHistoryStore.getInitialState(),
    ).entries[0]?.mentions,
  ).toEqual(entry.mentions);
});
it.each(["Before \uFFFC @src/a.ts between \uFFFC after", " \uFFFC @src/a.ts \uFFFC "])(
  "keeps mentions between terminal contexts: %s",
  (prompt) => {
    const terminalContexts = [context("A"), context("B")];
    const messageText = appendAttachedFilesToPrompt(
      appendTerminalContextsToPrompt(prompt, terminalContexts),
      ["docs/note.txt"],
    );
    const mention = createComposerMention("src/a.ts", prompt.indexOf("@src/a.ts"));
    useComposerMentionHistoryStore.getState().remember(
      createMentionHistoryEntry({
        threadId: "t",
        messageId: "m",
        prompt,
        mentions: [mention],
        terminalContexts,
        messageText,
      }),
    );
    const recalled = recallablePrompt(messageText);
    expect(recallComposerMentions("t", "m", recalled)).toEqual([
      {
        ...mention,
        start: recalled.indexOf("@src/a.ts"),
        end: recalled.indexOf("@src/a.ts") + 9,
      },
    ]);
  },
);
it("records accepted sends and reconnect recovery, not rejected transient artifacts", () => {
  const commandId = CommandId.makeUnsafe("command");
  const prompt = "Read @src/a.ts";
  const artifacts = {
    command: {
      threadId: "t",
      message: { messageId: "m", text: prompt },
    } as PendingTurnStartCommand,
    rollback: {
      prompt,
      mentions: [createComposerMention("src/a.ts", 5)],
      terminalContexts: [],
      images: [],
      filePaths: [],
      interactionMode: "default" as const,
    },
  };
  setPendingTurnDispatchArtifacts(commandId, artifacts);
  expect(useComposerMentionHistoryStore.getState().entries).toEqual([]);
  deletePendingTurnDispatchArtifacts(commandId);
  expect(useComposerMentionHistoryStore.getState().entries).toEqual([]);
  setPendingTurnDispatchArtifacts(commandId, artifacts);
  rememberAcceptedTurnMentions(commandId);
  rememberAcceptedTurnMentions(commandId);
  expect(useComposerMentionHistoryStore.getState().entries).toHaveLength(1);
  expect(recallComposerMentions("t", "m", prompt)).toHaveLength(1);
});
it("caps entry count and storage bytes, including hydration", () => {
  for (let index = 0; index < 205; index++)
    useComposerMentionHistoryStore.getState().remember(historyEntry(String(index)));
  expect(useComposerMentionHistoryStore.getState().entries).toHaveLength(200);
  expect(recallComposerMentions("t", "0", "Read @src/a.ts and @scope/pkg")).toEqual([]);
  const path = "src/" + "x".repeat(3000) + ".ts";
  const mentions = Array.from({ length: 10 }, (_, index) =>
    createComposerMention(path, index * (path.length + 2)),
  );
  const large = Array.from({ length: 200 }, (_, index) => ({
    threadId: "t",
    messageId: String(index),
    promptLength: 40000,
    mentions,
  }));
  const options = useComposerMentionHistoryStore.persist.getOptions();
  const merged = options.merge!(
    { entries: large },
    useComposerMentionHistoryStore.getInitialState(),
  );
  expect(merged.entries.length).toBeGreaterThan(0);
  expect(merged.entries.length).toBeLessThan(200);
  expect(mentionHistoryBytes(merged.entries)).toBeLessThanOrEqual(MAX_MENTION_HISTORY_BYTES);
  for (const entry of large) useComposerMentionHistoryStore.getState().remember(entry);
  expect(
    mentionHistoryBytes(useComposerMentionHistoryStore.getState().entries),
  ).toBeLessThanOrEqual(MAX_MENTION_HISTORY_BYTES);
});
it("does not persist prompt bodies and overwrites legacy bodies during migration", async () => {
  const prompt = "Read @src/a.ts " + "PRIVATE CONTENT ".repeat(8000);
  const entry = historyEntry("large", prompt);
  expect(JSON.stringify(entry)).not.toContain("PRIVATE CONTENT");
  expect(JSON.stringify(entry).length).toBeLessThan(300);
  let stored = JSON.stringify({ state: { entries: [{ ...entry, prompt }] }, version: 0 });
  useComposerMentionHistoryStore.persist.setOptions({
    storage: createJSONStorage(() => ({
      getItem: () => stored,
      setItem: (_key, value) => {
        stored = value;
      },
      removeItem: () => {
        stored = "";
      },
    })),
  });
  await useComposerMentionHistoryStore.persist.rehydrate();
  expect(useComposerMentionHistoryStore.getState().entries).toEqual([]);
  expect(stored).not.toContain("PRIVATE CONTENT");
});
it("evicts persisted history on quota failure without blocking draft saves", () => {
  const storage = {
    getItem: vi.fn(),
    setItem: vi.fn(() => {
      throw new Error("QuotaExceededError");
    }),
    removeItem: vi.fn(),
  };
  expect(() =>
    mentionHistoryStorage(() => storage).setItem(COMPOSER_MENTION_HISTORY_STORAGE_KEY, "metadata"),
  ).not.toThrow();
  expect(storage.removeItem).toHaveBeenCalledWith(COMPOSER_MENTION_HISTORY_STORAGE_KEY);
});
it("removes deleted threads and threads absent on reconnect", () => {
  const store = useComposerMentionHistoryStore.getState();
  store.remember(historyEntry());
  store.remember({ ...historyEntry("other"), threadId: "other" });
  store.forgetThread("t");
  expect(useComposerMentionHistoryStore.getState().entries.map((entry) => entry.threadId)).toEqual([
    "other",
  ]);
  store.retainThreads(new Set());
  expect(useComposerMentionHistoryStore.getState().entries).toEqual([]);
});
