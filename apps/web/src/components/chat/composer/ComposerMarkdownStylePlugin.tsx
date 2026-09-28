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
      if (editor.isComposing() || node.isTextEntity()) return;
      if (!enabled) {
        if (node.getStyle()) node.setStyle("");
        return;
      }
      const text = node.getTextContent();
      // Lexical merges adjacent text nodes with identical styles. Coalesce those
      // runs before splitting so normalization and this transform reach a fixed point.
      const runs: { text: string; style: string }[] = [];
      const append = (part: string) => {
        if (!part) return;
        const style = styleFor(part);
        const previous = runs.at(-1);
        if (previous?.style === style) previous.text += part;
        else runs.push({ text: part, style });
      };
      let cursor = 0;
      for (const match of text.matchAll(INLINE_MARKDOWN)) {
        append(text.slice(cursor, match.index));
        append(match[0]);
        cursor = match.index + match[0].length;
      }
      append(text.slice(cursor));
      let offset = 0;
      const boundaries = runs.slice(0, -1).map((run) => (offset += run.text.length));
      const nodes = boundaries.length ? node.splitText(...boundaries) : [node];
      for (const [index, part] of nodes.entries()) {
        const style = runs[index]?.style ?? "";
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
