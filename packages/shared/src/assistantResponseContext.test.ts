import { describe, expect, it } from "vitest";
import { MessageId, ThreadId, type AssistantResponseContext } from "@t3tools/contracts";
import {
  assistantResponseContextHref,
  assistantResponseContextMatches,
  parseAssistantResponseContextHref,
  responseContextsForProvider,
  serializeAssistantResponseContext,
  splitResponseReply,
} from "./assistantResponseContext";
import { searchableThreadSegments } from "./threadFindText";
const record: AssistantResponseContext = {
  version: 1,
  kind: "response",
  threadId: ThreadId.make("parent"),
  messageId: MessageId.make("message"),
  text: "Opening 🦊",
  subagents: [{ threadId: ThreadId.make("child"), title: "Review" }],
};
describe("assistant response references", () => {
  it("preserves code indentation after the reply separator", () => {
    const prompt = "    print(value)\n\tindented";
    expect(
      splitResponseReply(serializeAssistantResponseContext(record) + "\n\n" + prompt).prompt,
    ).toBe(prompt);
  });
  it("round-trips IDs, bounded opening text and subagent references through message text", () => {
    const link = serializeAssistantResponseContext(record);
    expect(parseAssistantResponseContextHref(assistantResponseContextHref(record))).toEqual(record);
    expect(splitResponseReply(link + "\n\nWhy?")).toEqual({ replyTo: record, prompt: "Why?" });
    expect(responseContextsForProvider(link + "\n\nWhy?")).toContain('"messageId":"message"');
    expect(responseContextsForProvider(link + "\n\nWhy?")).toContain("Opening 🦊");
    expect(responseContextsForProvider(link + "\n\nWhy?")).toContain("Why?");
    expect(responseContextsForProvider(link)).not.toContain("f5-context://");
  });
  it("does not decode literal examples in code or accept invalid/oversized records", () => {
    const link = serializeAssistantResponseContext(record);
    expect(assistantResponseContextMatches("inline `" + link + "`")).toEqual([]);
    expect(assistantResponseContextMatches("~~~\n" + link + "\n~~~")).toEqual([]);
    expect(parseAssistantResponseContextHref("f5-context://response/v1/%not-json")).toBeNull();
    expect(
      parseAssistantResponseContextHref(
        assistantResponseContextHref({ ...record, text: "x".repeat(301) }),
      ),
    ).toBeNull();
  });
  it("keeps Markdown delimiters in quoted text inside the reference", () => {
    const punctuation = { ...record, text: "Unmatched ) and ( plus '!*" };
    const link = serializeAssistantResponseContext(punctuation);
    expect(assistantResponseContextMatches(link)).toEqual([
      { start: 0, end: link.length, record: punctuation },
    ]);
    expect(splitResponseReply(link + "\n\nComment")).toEqual({
      replyTo: punctuation,
      prompt: "Comment",
    });
  });
  it("keeps cards out of Find while preserving their surrounding comment", () => {
    expect(
      searchableThreadSegments(
        serializeAssistantResponseContext({ ...record, kind: "quote" }) + "\n\nExplain this",
      ),
    ).toEqual(["Explain this"]);
  });
});
