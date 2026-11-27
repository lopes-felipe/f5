import {
  $applyNodeReplacement,
  DecoratorNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { FileTextIcon } from "lucide-react";
import type { ReactElement } from "react";
import { mcpResourceReferenceMatches } from "@t3tools/shared/mcpComposer";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../../composerInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

type SerializedMcpResourceReference = Spread<
  {
    type: "composer-mcp-resource";
    version: 1;
    raw: string;
  },
  SerializedLexicalNode
>;

/**
 * A chosen MCP resource. Its source stays an ordinary Markdown link, and the
 * resource is read and appended to the message when it is sent.
 */
export class ComposerMcpResourceReferenceNode extends DecoratorNode<ReactElement> {
  __raw: string;
  static override getType() {
    return "composer-mcp-resource";
  }
  static override clone(node: ComposerMcpResourceReferenceNode) {
    return new ComposerMcpResourceReferenceNode(node.__raw, node.__key);
  }
  static override importJSON(serialized: SerializedMcpResourceReference) {
    return $createMcpResourceReferenceNode(serialized.raw);
  }
  constructor(raw: string, key?: NodeKey) {
    super(key);
    this.__raw = raw;
  }
  override exportJSON(): SerializedMcpResourceReference {
    return { ...super.exportJSON(), type: "composer-mcp-resource", version: 1, raw: this.__raw };
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
    const match = mcpResourceReferenceMatches(this.__raw)[0];
    if (!match || match.raw !== this.__raw) return <span>{this.__raw}</span>;
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              contentEditable={false}
              spellCheck={false}
              className={COMPOSER_INLINE_CHIP_CLASS_NAME}
              data-composer-mcp-resource="true"
            >
              <FileTextIcon className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
              <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
                {match.serverName}: {match.label}
              </span>
            </span>
          }
        />
        <TooltipPopup className="max-w-[30rem] break-all">
          {match.uri} from {match.serverName}. Its contents are added when you send.
        </TooltipPopup>
      </Tooltip>
    );
  }
}
export function $createMcpResourceReferenceNode(raw: string) {
  return $applyNodeReplacement(new ComposerMcpResourceReferenceNode(raw));
}
