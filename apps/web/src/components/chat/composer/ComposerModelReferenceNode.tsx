import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { collectComposerModelMentions } from "@t3tools/shared/composerModelMentions";
import type { ReactElement } from "react";
import { ModelMentionChip } from "../ModelMentionChip";
type SerializedModel = Spread<
  { type: "composer-model-reference"; version: 1; raw: string },
  SerializedLexicalNode
>;
export class ComposerModelReferenceNode extends DecoratorNode<ReactElement> {
  __raw: string;
  static override getType() {
    return "composer-model-reference";
  }
  static override clone(node: ComposerModelReferenceNode) {
    return new ComposerModelReferenceNode(node.__raw, node.__key);
  }
  static override importJSON(node: SerializedModel) {
    return $createModelReferenceNode(node.raw);
  }
  constructor(raw: string, key?: NodeKey) {
    super(key);
    this.__raw = raw;
  }
  override exportJSON(): SerializedModel {
    return { ...super.exportJSON(), type: "composer-model-reference", version: 1, raw: this.__raw };
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
    const mention = collectComposerModelMentions(this.__raw)[0];
    return mention ? (
      <ModelMentionChip instanceId={mention.instanceId} model={mention.model} />
    ) : (
      <span>{this.__raw}</span>
    );
  }
}
export function $createModelReferenceNode(raw: string) {
  return $applyNodeReplacement(new ComposerModelReferenceNode(raw));
}
