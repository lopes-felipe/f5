import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { threadReferenceMatches } from "@t3tools/shared/threadReferences";
import type { ReactElement } from "react";
import { ThreadReferenceChip } from "../ThreadReferenceChip";

type SerializedThreadReference = Spread<
  {
    type: "composer-thread-reference";
    version: 1;
    raw: string;
  },
  SerializedLexicalNode
>;

/** A local visual token whose complete source remains an ordinary thread reference link. */
export class ComposerThreadReferenceNode extends DecoratorNode<ReactElement> {
  __raw: string;
  static override getType() {
    return "composer-thread-reference";
  }
  static override clone(node: ComposerThreadReferenceNode) {
    return new ComposerThreadReferenceNode(node.__raw, node.__key);
  }
  static override importJSON(serialized: SerializedThreadReference) {
    return $createThreadReferenceNode(serialized.raw);
  }
  constructor(raw: string, key?: NodeKey) {
    super(key);
    this.__raw = raw;
  }
  override exportJSON(): SerializedThreadReference {
    return {
      ...super.exportJSON(),
      type: "composer-thread-reference",
      version: 1,
      raw: this.__raw,
    };
  }
  override createDOM() {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }
  override updateDOM(): false {
    return false;
  }
  override isInline(): true {
    return true;
  }
  override getTextContent() {
    return this.__raw;
  }
  override decorate(): ReactElement {
    const match = threadReferenceMatches(this.__raw)[0];
    if (!match || match.raw !== this.__raw) return <span>{this.__raw}</span>;
    return (
      <span data-composer-thread-reference="true" className="inline-flex max-w-full">
        <ThreadReferenceChip threadId={match.threadId} label={match.label} />
      </span>
    );
  }
}
export function $createThreadReferenceNode(raw: string) {
  return $applyNodeReplacement(new ComposerThreadReferenceNode(raw));
}
