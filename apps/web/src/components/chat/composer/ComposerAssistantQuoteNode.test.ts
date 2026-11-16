import { createEditor, $getRoot, $createParagraphNode } from "lexical";
import { expect, it } from "vitest";
import {
  ComposerAssistantQuoteNode,
  $createAssistantQuoteNode,
  assistantQuoteLimitError,
  serializeAssistantQuote,
} from "./ComposerAssistantQuoteNode";

it("bounds quotes and serializes every line as a portable blockquote", () => {
  expect(
    serializeAssistantQuote({ messageId: "a", text: "one\r\ntwo", comment: " explain " }),
  ).toBe("> one\n> two\n\nexplain");
  expect(
    serializeAssistantQuote({ messageId: "a", text: "x".repeat(5000), comment: "" }),
  ).toHaveLength(4002);
});
it("quotes the agent's thread references as plain labels so they never grant access", () => {
  expect(
    serializeAssistantQuote({
      messageId: "a",
      text: "Read [Other project](f5://thread/secret-thread)",
      comment: "Also see [Mine](f5://thread/mine)",
    }),
  ).toBe("> Read Other project\n\nAlso see [Mine](f5://thread/mine)");
});
it("round-trips quote metadata through Lexical while keeping plain draft text usable", () => {
  const editor = createEditor({
    nodes: [ComposerAssistantQuoteNode],
    onError: (error) => {
      throw error;
    },
  });
  const quote = { messageId: "assistant-1", text: "**quoted**", comment: "Explain" };
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createAssistantQuoteNode(quote)));
    },
    { discrete: true },
  );
  const json = editor.getEditorState().toJSON();
  expect(JSON.stringify(json)).toContain('"messageId":"assistant-1"');
  const restored = editor.parseEditorState(json);
  restored.read(() => expect($getRoot().getTextContent()).toBe("> **quoted**\n\nExplain"));
});

it("rejects a quote that would push the draft over the limit", () => {
  const quote = { messageId: "a", text: "abc", comment: "" };
  // "> abc" plus the blank line that separates it from the draft.
  const quoteLength = serializeAssistantQuote(quote).length + 2;
  expect(assistantQuoteLimitError(10, quote, 10 + quoteLength)).toBeNull();
  expect(assistantQuoteLimitError(11, quote, 10 + quoteLength)).toBe(
    "This quote would exceed the message limit.",
  );
  expect(assistantQuoteLimitError(0, quote, 0)).toBe(
    "Waiting for server capabilities. Reconnect before adding a quote.",
  );
});
