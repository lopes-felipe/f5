import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot, $isElementNode, $isTextNode, TextNode, type LexicalNode } from "lexical";
import { useEffect } from "react";

const INLINE_MARKDOWN =
  /(?<!\\)(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g;
function styleFor(text: string): string {
  if (/^\*\*[^*\n]+\*\*$|^__[^_\n]+__$/.test(text)) return "font-weight: 700";
  if (/^`[^`\n]+`$/.test(text))
    return "font-family: var(--font-mono); background-color: var(--muted)";
  if (/^~~[^~\n]+~~$/.test(text)) return "text-decoration: line-through";
  if (/^\*[^*\n]+\*$|^_[^_\n]+_$/.test(text)) return "font-style: italic";
  if (/^#{1,6}\s+/.test(text)) return "font-weight: 700";
  return "";
}

/** Style Markdown without rewriting its bytes, selection offsets, or inline context nodes. */
export function ComposerMarkdownStylePlugin({ enabled }: { enabled: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const transform = (node: TextNode) => {
      if (editor.isComposing()) return;
      if (!enabled) {
        if (node.getStyle()) node.setStyle("");
        return;
      }
      const text = node.getTextContent();
      const boundaries = new Set<number>();
      for (const match of text.matchAll(INLINE_MARKDOWN)) {
        if (match.index > 0) boundaries.add(match.index);
        if (match.index + match[0].length < text.length)
          boundaries.add(match.index + match[0].length);
      }
      const nodes = boundaries.size
        ? node.splitText(...[...boundaries].sort((a, b) => a - b))
        : [node];
      for (const part of nodes) {
        const style = styleFor(part.getTextContent());
        if (part.getStyle() !== style) part.setStyle(style);
      }
    };
    const unregister = editor.registerNodeTransform(TextNode, transform);
    editor.update(() => {
      const visit = (node: LexicalNode) => {
        if ($isTextNode(node)) transform(node);
        else if ($isElementNode(node)) for (const child of node.getChildren()) visit(child);
      };
      visit($getRoot());
    });
    return unregister;
  }, [editor, enabled]);
  return null;
}
