import { createEditor, $getRoot, $createParagraphNode } from "lexical";
import { expect, it } from "vitest";
import {
  ComposerAssistantQuoteNode,
  $createAssistantQuoteNode,
} from "./ComposerAssistantQuoteNode";
import { assistantResponseContextMatches } from "@t3tools/shared/assistantResponseContext";

it("exports nonempty HTML with the complete quote record and leaves comments separate", () => {
  const editor = createEditor({
    nodes: [ComposerAssistantQuoteNode],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(
    () => {
      const node = $createAssistantQuoteNode({
        messageId: "message",
        threadId: "source",
        text: "Selected",
        comment: "Separate comment",
        turnId: "turn" as import("@t3tools/contracts").TurnId,
        subagents: [
          { threadId: "child" as import("@t3tools/contracts").ThreadId, title: "Worker" },
        ],
      });
      $getRoot().append($createParagraphNode().append(node));
      const element = node.exportDOM().element;
      expect(element.textContent).not.toContain("Separate comment");
      const record = assistantResponseContextMatches(element.textContent ?? "")[0]?.record;
      expect(record).toMatchObject({
        text: "Selected",
        turnId: "turn",
        subagents: [{ threadId: "child" }],
      });
    },
    { discrete: true },
  );
});
