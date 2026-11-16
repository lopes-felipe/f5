import { fromMarkdown } from "mdast-util-from-markdown";
import { isUncPath, isWindowsDrivePath } from "./path";

function pathKey(value: string, decode = false): string {
  let path = value.replace(/^file:\/\//i, "");
  if (value.toLowerCase().startsWith("file://") && !path.startsWith("/")) path = "//" + path;
  if (decode) {
    try {
      path = decodeURIComponent(path);
    } catch {
      /* Keep literal malformed escapes. */
    }
  }
  return isWindowsDrivePath(path) || /^[\\/]{2}/.test(path)
    ? path.replaceAll("\\", "/").toLowerCase()
    : path;
}

/** Add only images the rendered Markdown does not already display. */
export function appendGeneratedImageEmbeds(text: string, saved: Iterable<string>): string {
  const root = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const shown = new Set<string>();
  const sourceUrl = (node: (typeof root.children)[number], url: string) => {
    const source = text.slice(node.position?.start.offset, node.position?.end.offset);
    // CommonMark consumes Windows separators before punctuation. Match the raw
    // destination only on nodes the parser has already identified as images/definitions.
    const raw = /(?:\]\(|:\s*)<?((?:[a-z]:\\|\\\\)[^\r\n]*?)(?:>|\))?$/i.exec(source)?.[1];
    return raw ?? url;
  };
  for (const node of root.children)
    if (node.type === "definition")
      definitions.set(node.identifier.toUpperCase(), sourceUrl(node, node.url));
  function visit(node: typeof root | (typeof root.children)[number]): void {
    if (node.type === "image") shown.add(pathKey(sourceUrl(node, node.url), true));
    if (node.type === "imageReference") {
      const url = definitions.get(node.identifier.toUpperCase());
      if (url) shown.add(pathKey(url, true));
    }
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(root);
  const missing: string[] = [];
  for (const path of saved) {
    const key = pathKey(path);
    if (shown.has(key)) continue;
    shown.add(key);
    const destination = isWindowsDrivePath(path)
      ? path.replaceAll("\\", "/")
      : isUncPath(path)
        ? "file:" + path.replaceAll("\\", "/")
        : path;
    missing.push(
      "![](<" +
        destination.replace(/[%?#&\\\r\n]/g, encodeURIComponent).replace(/[<>]/g, "\\$&") +
        ">)",
    );
  }
  if (!missing.length) return text;
  const last = root.children.at(-1);
  const source = text.slice(last?.position?.start.offset, last?.position?.end.offset);
  let end: string | undefined;
  if (last?.type === "code") {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(source)?.[1];
    const lines = source.split(/\r\n|\r|\n/);
    const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(lines.at(-1) ?? "")?.[1];
    if (
      fence &&
      !(
        lines.length > 1 &&
        closing !== undefined &&
        closing[0] === fence[0] &&
        closing.length >= fence.length
      )
    )
      end = fence;
  } else if (last?.type === "html") {
    const tag = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(source)?.[1];
    if (tag && !/<\/(?:script|pre|style|textarea)>/i.test(source)) end = "</" + tag + ">";
    else if (/^ {0,3}<!--/.test(source) && !source.includes("-->")) end = "-->";
  }
  const prefix = end ? text + (/\n$/.test(text) ? "" : "\n") + end : text;
  return (prefix ? prefix + "\n\n" : "") + missing.join("\n\n");
}
