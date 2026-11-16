import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { GitPullRequestIcon } from "lucide-react";
import type { ReactElement } from "react";
import { pullRequestReferenceMatches } from "../../../lib/pullRequestReference";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

type SerializedPullRequestReference = Spread<
  {
    type: "composer-pull-request";
    version: 1;
    raw: string;
  },
  SerializedLexicalNode
>;

/** A local visual token whose complete source remains an ordinary PR Markdown reference. */
export class ComposerPullRequestReferenceNode extends DecoratorNode<ReactElement> {
  __raw: string;
  static override getType() {
    return "composer-pull-request";
  }
  static override clone(node: ComposerPullRequestReferenceNode) {
    return new ComposerPullRequestReferenceNode(node.__raw, node.__key);
  }
  static override importJSON(serialized: SerializedPullRequestReference) {
    return $createPullRequestReferenceNode(serialized.raw);
  }
  constructor(raw: string, key?: NodeKey) {
    super(key);
    this.__raw = raw;
  }
  override exportJSON(): SerializedPullRequestReference {
    return { ...super.exportJSON(), type: "composer-pull-request", version: 1, raw: this.__raw };
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
    const match = pullRequestReferenceMatches(this.__raw)[0];
    if (!match || match.raw !== this.__raw) return <span>{this.__raw}</span>;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              contentEditable={false}
              spellCheck={false}
              className={COMPOSER_INLINE_CHIP_CLASS_NAME}
              data-composer-pr-reference="true"
            >
              <GitPullRequestIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
              <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
                {match.ref.repository}#{match.ref.number}
              </span>
            </span>
          }
        />
        <TooltipPopup className="max-w-[30rem] break-all">{match.url}</TooltipPopup>
      </Tooltip>
    );
  }
}
export function $createPullRequestReferenceNode(raw: string) {
  return $applyNodeReplacement(new ComposerPullRequestReferenceNode(raw));
}
