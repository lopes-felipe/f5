import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { ReactElement } from "react";
import { threadReferencesToLabels } from "@t3tools/shared/threadReferences";
import { serializeAssistantResponseContext } from "@t3tools/shared/assistantResponseContext";
import { MessageId, ThreadId } from "@t3tools/contracts";

export interface AssistantQuote {
  messageId: string;
  text: string;
  comment: string;
  reply?: boolean | undefined;
  threadId?: string | undefined;
  prefix?: string | undefined;
  suffix?: string | undefined;
}
export function serializeAssistantQuote(quote: AssistantQuote): string {
  if (quote.threadId)
    return [
      serializeAssistantResponseContext({
        version: 1,
        kind: "quote",
        threadId: ThreadId.make(quote.threadId),
        messageId: MessageId.make(quote.messageId),
        text: threadReferencesToLabels(quote.text).slice(0, 4000),
        prefix: quote.prefix?.slice(-150),
        suffix: quote.suffix?.slice(0, 150),
      }),
      quote.comment.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");
  // The agent wrote the quoted text, so its thread references become plain labels: only a
  // reference a person adds grants the agent access to that thread.
  const quoted = threadReferencesToLabels(quote.text)
    .slice(0, 4000)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n${quote.comment.trim()}`.trimEnd();
}

/**
 * Why a quote cannot join a draft of `currentLength` characters, or null. The
 * two extra characters are the blank line that separates it from the draft.
 */
export function assistantQuoteLimitError(
  currentLength: number,
  quote: AssistantQuote,
  maxLength: number,
): string | null {
  if (maxLength <= 0) return "Waiting for server capabilities. Reconnect before adding a quote.";
  if (currentLength + serializeAssistantQuote(quote).length + 2 > maxLength) {
    return "This quote would exceed the message limit.";
  }
  return null;
}
type SerializedQuote = Spread<
  { type: "composer-assistant-quote"; version: 1; quote: AssistantQuote },
  SerializedLexicalNode
>;

/** Portable Markdown is the durable draft representation; message identity stays local to the editor. */
export class ComposerAssistantQuoteNode extends DecoratorNode<ReactElement> {
  __quote: AssistantQuote;
  static override getType() {
    return "composer-assistant-quote";
  }
  static override clone(node: ComposerAssistantQuoteNode) {
    return new ComposerAssistantQuoteNode(node.__quote, node.__key);
  }
  static override importJSON(node: SerializedQuote) {
    return $createAssistantQuoteNode(node.quote);
  }
  constructor(quote: AssistantQuote = { messageId: "", text: "", comment: "" }, key?: NodeKey) {
    const bounded = { ...quote, text: quote.text.slice(0, 4000) };
    super(key);
    this.__quote = bounded;
  }
  override exportJSON(): SerializedQuote {
    return {
      ...super.exportJSON(),
      type: "composer-assistant-quote",
      version: 1,
      quote: this.__quote,
    };
  }
  override isInline(): true {
    return true;
  }
  override getTextContent() {
    return serializeAssistantQuote(this.__quote);
  }
  override createDOM() {
    const node = document.createElement("span");
    node.className = "inline-flex align-middle";
    return node;
  }
  override updateDOM(): false {
    return false;
  }
  override decorate(): ReactElement {
    return (
      <span data-composer-assistant-quote className="whitespace-pre-wrap">
        {serializeAssistantQuote({ ...this.__quote, threadId: undefined })}
      </span>
    );
  }
}
export function $createAssistantQuoteNode(quote: AssistantQuote) {
  return $applyNodeReplacement(new ComposerAssistantQuoteNode(quote));
}
