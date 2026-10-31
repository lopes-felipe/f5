import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";
import { HTML_RENDER_MAX_SOURCE_BYTES, HTML_RENDER_MAX_PAGE_BYTES } from "@t3tools/contracts";
import { openContainedFile } from "../assetHttp.ts";

const MIMES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class HtmlRenderViewportHeightError extends Error {
  constructor(found: string) {
    super(
      `The page uses a viewport height unit (${found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`,
    );
  }
}

// Only stylesheets and style attributes are checked, so page text that mentions
// a unit passes; comments match first so their contents are skipped. Scripts
// are still checked, since markup they insert applies. An unclosed comment,
// tag, or quote runs to the end of the page, which keeps both patterns linear
// on hostile input.
const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

/** Rejects vh, svh, lvh and dvh units: the frame fits the page, so they would grow it without end. */
export function rejectViewportHeightUnits(html: string): void {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const css = sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const found = VIEWPORT_HEIGHT_UNIT.exec(css)?.[0];
    if (found !== undefined) throw new HtmlRenderViewportHeightError(found);
  }
}

/** Inline local images through the same inode-checked containment boundary as file serving. */
export async function prepareHtmlRender(
  html: string,
  roots: ReadonlyArray<string>,
): Promise<string> {
  if (Buffer.byteLength(html) > HTML_RENDER_MAX_SOURCE_BYTES)
    throw new Error("HTML source exceeds 512 KiB.");
  rejectViewportHeightUnits(html);
  const document = parse(html);
  const pending: DefaultTreeAdapterMap["node"][] = [document];
  const images = new Map<string, string>();
  let nodes = 0;
  let inlinedBytes = Buffer.byteLength(html);
  while (pending.length) {
    if (++nodes > 50_000) throw new Error("HTML has too many nodes.");
    const node = pending.pop()!;
    if ("childNodes" in node) pending.push(...node.childNodes);
    if ("content" in node) pending.push(node.content);
    if (!("tagName" in node)) continue;
    const names =
      node.tagName === "img" || node.tagName === "source"
        ? ["src"]
        : node.tagName === "image"
          ? ["href"]
          : node.tagName === "video"
            ? ["poster"]
            : [];
    for (const attribute of node.attrs) {
      if (!names.includes(attribute.name)) continue;
      let local = attribute.value;
      if (local.startsWith("file:")) local = fileURLToPath(local);
      if (local.startsWith("//") || !path.isAbsolute(local)) continue;
      let encoded = images.get(local);
      if (!encoded) {
        const mime = MIMES[path.extname(local).toLowerCase()];
        if (!mime) throw new Error("Unsupported local image format.");
        const root = roots.find((root) => {
          const relative = path.relative(path.resolve(root), local);
          return (
            relative !== "" &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
          );
        });
        if (!root)
          throw new Error(
            "Local images must stay inside the project, worktree or attachment roots.",
          );
        const file = await openContainedFile(root, path.relative(path.resolve(root), local));
        try {
          if ((await file.stat()).size > MAX_IMAGE_BYTES)
            throw new Error("A local image exceeds 10 MiB.");
          const chunks: Buffer[] = [];
          let total = 0;
          for (;;) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_IMAGE_BYTES + 1 - total));
            const { bytesRead } = await file.read(buffer);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > MAX_IMAGE_BYTES) throw new Error("A local image exceeds 10 MiB.");
            chunks.push(buffer.subarray(0, bytesRead));
          }
          encoded = `data:${mime};base64,${Buffer.concat(chunks).toString("base64")}`;
          images.set(local, encoded);
        } finally {
          await file.close();
        }
      }
      inlinedBytes += Buffer.byteLength(encoded);
      if (inlinedBytes > HTML_RENDER_MAX_PAGE_BYTES)
        throw new Error("The inlined page exceeds 25 MiB.");
      attribute.value = encoded;
    }
  }
  const prepared = serialize(document);
  if (Buffer.byteLength(prepared) > HTML_RENDER_MAX_PAGE_BYTES)
    throw new Error("The inlined page exceeds 25 MiB.");
  return prepared;
}
