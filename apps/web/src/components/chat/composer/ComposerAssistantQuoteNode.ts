import {
  $applyNodeReplacement,
  TextNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import { threadReferencesToLabels } from "@t3tools/shared/threadReferences";

export interface AssistantQuote {
  messageId: string;
  text: string;
  comment: string;
}
export function serializeAssistantQuote(quote: AssistantQuote): string {
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
  SerializedTextNode
>;

/** Portable Markdown is the durable draft representation; message identity stays local to the editor. */
export class ComposerAssistantQuoteNode extends TextNode {
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
    super(serializeAssistantQuote(bounded), key);
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
  override isTextEntity() {
    return true;
  }
}
export function $createAssistantQuoteNode(quote: AssistantQuote) {
  return $applyNodeReplacement(new ComposerAssistantQuoteNode(quote)).setMode("token");
}
