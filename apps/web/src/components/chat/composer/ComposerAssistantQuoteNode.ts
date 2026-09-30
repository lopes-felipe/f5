import {
  $applyNodeReplacement,
  TextNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

export interface AssistantQuote {
  messageId: string;
  text: string;
  comment: string;
}
export function serializeAssistantQuote(quote: AssistantQuote): string {
  const quoted = quote.text
    .slice(0, 4000)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${quoted}\n\n${quote.comment.trim()}`.trimEnd();
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
