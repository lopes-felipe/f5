import { createEditor, $getRoot, $createParagraphNode } from "lexical";
import { expect, it } from "vitest";
import {
  ComposerAssistantQuoteNode,
  $createAssistantQuoteNode,
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
