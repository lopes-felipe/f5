import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface TextNode {
  readonly type: string;
  readonly value?: string;
  readonly alt?: string | null | undefined;
  readonly children?: readonly TextNode[];
}
const blocks = new Set([
  "paragraph",
  "heading",
  "code",
  "blockquote",
  "listItem",
  "tableCell",
  "thematicBreak",
]);
/** Search the displayed Markdown text, without indexing URLs, definitions or markup. */
export function searchableThreadSegments(markdown: string): readonly string[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const segments: string[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) segments.push(text);
    text = "";
  };
  const visit = (node: TextNode, pre = false) => {
    if (["definition", "html", "yaml"].includes(node.type)) return;
    const block = blocks.has(node.type);
    if (block) flush();
    if (node.type === "image" || node.type === "imageReference") text += node.alt ?? "";
    else if (node.type === "break") flush();
    else if (node.value !== undefined)
      text += pre || node.type === "code" ? node.value : node.value.replace(/\r?\n/g, " ");
    for (const child of node.children ?? []) visit(child, pre || node.type === "code");
    if (block) flush();
  };
  visit(root);
  flush();
  return segments;
}
