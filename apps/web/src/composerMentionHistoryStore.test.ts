import { beforeEach, expect, it } from "vitest";
import { createComposerMention } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";
import {
  recallComposerMentions,
  useComposerMentionHistoryStore,
} from "./composerMentionHistoryStore";

beforeEach(() => useComposerMentionHistoryStore.setState({ entries: [] }));

it("restores local mention provenance only for the corresponding thread and message", () => {
  const prompt = "Read @src/a.ts and @scope/pkg ";
  const mentions = [createComposerMention("src/a.ts", 5)];
  useComposerMentionHistoryStore
    .getState()
    .remember({ threadId: "t", messageId: "m", prompt, mentions });
  expect(recallComposerMentions("t", "m", prompt.trim())).toEqual(mentions);
  expect(recallComposerMentions("other", "m", prompt)).toEqual([]);
  expect(recallComposerMentions("t", "old", prompt)).toEqual([]);
  expect(recallComposerMentions("t", "m", "different")).toEqual([]);
  const options = useComposerMentionHistoryStore.persist.getOptions();
  const persisted = options.partialize!(useComposerMentionHistoryStore.getState());
  const hydrated = options.merge!(persisted, useComposerMentionHistoryStore.getInitialState());
  expect(hydrated.entries[0]?.mentions).toEqual(mentions);
});

it("bounds retained history", () => {
  for (let index = 0; index < 205; index++) {
    useComposerMentionHistoryStore.getState().remember({
      threadId: "t",
      messageId: String(index),
      prompt: "@src/a.ts",
      mentions: [createComposerMention("src/a.ts", 0)],
    });
  }
  expect(useComposerMentionHistoryStore.getState().entries).toHaveLength(200);
  expect(recallComposerMentions("t", "0", "@src/a.ts")).toEqual([]);
});

it("retains selected files when recalled text omits surrounding terminal selections and whitespace", () => {
  const prompt =
    " " +
    INLINE_TERMINAL_CONTEXT_PLACEHOLDER +
    " @src/a.ts " +
    INLINE_TERMINAL_CONTEXT_PLACEHOLDER +
    " ";
  const mention = createComposerMention("src/a.ts", 3);
  useComposerMentionHistoryStore.getState().remember({
    threadId: "t",
    messageId: "terminal",
    prompt,
    mentions: [mention],
  });
  expect(recallComposerMentions("t", "terminal", "@src/a.ts")).toEqual([
    { ...mention, start: 0, end: 9 },
  ]);
});
