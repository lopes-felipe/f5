import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { splitGfmAlert } from "./markdownAlerts";

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
/**
 * Search the displayed Markdown text, without indexing URLs, definitions or markup.
 * `renderAlerts` matches surfaces that render `> [!NOTE]` as a titled callout
 * (assistant messages, plans); user bubbles show the marker literally.
 */
export function searchableThreadSegments(
  markdown: string,
  options: { readonly renderAlerts?: boolean } = {},
): readonly string[] {
  const renderAlerts = options.renderAlerts ?? true;
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
  const visit = (node: TextNode, pre = false, topLevel = false) => {
    if (["definition", "html", "yaml"].includes(node.type)) return;
    const block = blocks.has(node.type);
    if (block) flush();
    if (node.type === "image" || node.type === "imageReference") text += node.alt ?? "";
    else if (node.type === "break") flush();
    else if (node.value !== undefined)
      text += pre || node.type === "code" ? node.value : node.value.replace(/\r?\n/g, " ");
    for (const child of node.children ?? []) {
      // The renderer shows an alert's marker as a title, which find ignores.
      const alert =
        renderAlerts && topLevel && child.type === "blockquote" && child.children
          ? splitGfmAlert({ children: child.children })
          : null;
      visit(alert ? { ...child, children: alert.children } : child, pre || node.type === "code");
    }
    if (block) flush();
  };
  visit(root, false, true);
  flush();
  return segments;
}
