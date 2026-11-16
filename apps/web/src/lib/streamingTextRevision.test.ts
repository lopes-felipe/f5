import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types";
import { advanceStreamingMarkdown } from "./streamingMarkdown";
import {
  messageReasoningContent,
  messageTextRevision,
  recordMessageAppend,
  suffixSince,
} from "./streamingTextRevision";

function message(text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe("message"),
    role: "assistant",
    text,
    streaming: true,
    createdAt: "2026-04-01T00:00:00.000Z",
  };
}
function append(previous: ChatMessage, suffix: string): ChatMessage {
  const next = { ...previous, text: previous.text + suffix };
  recordMessageAppend(previous, next, suffix, "");
  return next;
}
describe("streaming text provenance", () => {
  it("covers skipped renders, reasoning-only changes and rejects replacements or expired bases", () => {
    const original = message("prefix");
    let current = append(original, " first");
    const base = messageTextRevision(original);
    current = append(current, " second");
    expect(suffixSince(base, messageTextRevision(current))).toBe(" first second");
    const reasoned = { ...current, reasoningText: "thought" };
    recordMessageAppend(current, reasoned, "", "thought");
    expect(suffixSince(messageTextRevision(current), messageTextRevision(reasoned))).toBe("");
    expect(suffixSince(base, messageTextRevision({ ...current }))).toBeNull();
    for (let index = 0; index < 40; index++) current = append(current, "x");
    expect(messageTextRevision(current)?.recent.length).toBeLessThanOrEqual(32);
    expect(suffixSince(base, messageTextRevision(current))).toBeNull();
    current = append(current, "x".repeat(70 * 1024));
    expect(messageTextRevision(current)?.recent).toEqual([]);
  });
  it.each(["A paragraph", "```typescript\nconst value = 1;\n"])(
    "processes appended characters linearly for %s",
    (prefix) => {
      let current = message(prefix);
      const next = append(current, "hello");
      let state = advanceStreamingMarkdown(null, current.text, messageTextRevision(current));
      current = next;
      for (let index = 0; index < 1000; index++) {
        state = advanceStreamingMarkdown(state, current.text, messageTextRevision(current));
        current = append(current, " alphabet" + (prefix.startsWith("```") ? "\n" : ""));
      }
      expect(state.parsedCharacters).toBeLessThanOrEqual(current.text.length * 2);
      expect(state.validatedCharacters).toBe(0);
    },
  );
  it.each([
    "```js\ncode\n```\n\n# Heading\n\nDone",
    "~~~python\n  ```\ntext\n~~~~\r\nDone",
    "Paragraph\n\n- one\n- two\n\nDone",
    "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nDone",
    "> quote\n> more\n\nDone",
  ])("matches the validated parser across syntax boundaries: %s", (text) => {
    let current = message("");
    let incremental = advanceStreamingMarkdown(null, "");
    let reference = incremental;
    for (const suffix of text) {
      const next = append(current, suffix);
      incremental = advanceStreamingMarkdown(incremental, next.text, messageTextRevision(next));
      reference = advanceStreamingMarkdown(reference, next.text);
      expect({
        blocks: incremental.sealedBlocks,
        active: incremental.activeBlock,
        kind: incremental.activeBlockKind,
      }).toEqual({
        blocks: reference.sealedBlocks,
        active: reference.activeBlock,
        kind: reference.activeBlockKind,
      });
      current = next;
    }
    const replaced = advanceStreamingMarkdown(incremental, "replacement", undefined);
    expect(replaced.needsFullRebuild).toBe(true);
    expect(replaced.activeBlock).toBe("replacement");
  });
});

it("keeps reasoning display trimming and append provenance exact across whitespace deltas", () => {
  let current = { ...message(""), reasoningText: "\n  thinking \n" };
  let rendered = messageReasoningContent(current);
  for (const delta of [" ", "more", "\n", " ", "thoughts  ", "", "done\n"]) {
    const next = { ...current, reasoningText: current.reasoningText + delta };
    recordMessageAppend(current, next, "", delta);
    const content = messageReasoningContent(next);
    expect(content.text).toBe(next.reasoningText.trim());
    const suffix = suffixSince(rendered.revision, content.revision);
    expect(suffix).not.toBeNull();
    expect(rendered.text + suffix).toBe(content.text);
    rendered = content;
    current = next;
  }
});

it.each([
  { prefix: "- first item\n", suffix: "- another item\n" },
  { prefix: "> first line\n", suffix: "> another line\n" },
  { prefix: "| A | B |\n| --- | --- |\n", suffix: "| one | two |\n" },
])("processes growing structured blocks linearly: $prefix", ({ prefix, suffix }) => {
  let current = message(prefix);
  const initialized = append(current, "");
  let state = advanceStreamingMarkdown(null, current.text, messageTextRevision(current));
  current = initialized;
  for (let index = 0; index < 1000; index++) {
    current = append(current, suffix);
    state = advanceStreamingMarkdown(state, current.text, messageTextRevision(current));
  }
  expect(state.parsedCharacters).toBeLessThanOrEqual(current.text.length * 3);
  expect(state.validatedCharacters).toBe(0);
  const rebuilt = advanceStreamingMarkdown(null, current.text);
  expect(state.sealedBlocks).toEqual(rebuilt.sealedBlocks);
  expect(state.activeBlock).toBe(rebuilt.activeBlock);
  current = append(current, "\nEnd of block");
  state = advanceStreamingMarkdown(state, current.text, messageTextRevision(current));
  const finished = advanceStreamingMarkdown(null, current.text);
  expect(state.sealedBlocks).toEqual(finished.sealedBlocks);
  expect(state.activeBlock).toBe(finished.activeBlock);
});
