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
const MAX_NODES = 50_000;
export const HTML_RENDER_MAX_LISTED_IMAGES = 20;
const MAX_LISTED_PATH_LENGTH = 1024;

/**
 * A page the agent can fix. The message names only limits and the paths the
 * agent wrote, so it is safe to return to the agent as is.
 */
export class HtmlRenderPrepareError extends Error {
  override readonly name = "HtmlRenderPrepareError";
}

export interface PreparedHtmlRender {
  readonly html: string;
  /** In-root images that could not be read, listed once each and bounded. */
  readonly missing: { readonly paths: ReadonlyArray<string>; readonly omitted: number };
}

const shorten = (value: string) =>
  value.length > MAX_LISTED_PATH_LENGTH ? `${value.slice(0, MAX_LISTED_PATH_LENGTH - 1)}…` : value;
const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

/** CSS without comments and quoted strings, so `/* 100vh *\/` and `content:"100vh"` pass. */
function cssCode(css: string): string {
  let code = "";
  let index = 0;
  while (index < css.length) {
    const char = css[index]!;
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      code += " ";
    } else if (char === '"' || char === "'") {
      index++;
      while (index < css.length && css[index] !== char && css[index] !== "\n") {
        index += css[index] === "\\" ? 2 : 1;
      }
      index++;
      code += " ";
    } else if (char === "\\") {
      // `100\76h` is `100vh`.
      const hex = /^\\([0-9a-f]{1,6})[ \t\n]?/i.exec(css.slice(index, index + 8));
      const point = hex ? Number.parseInt(hex[1]!, 16) : 0;
      code += hex
        ? point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : "�"
        : (css[index + 1] ?? "");
      index += hex ? hex[0].length : 2;
    } else {
      code += char;
      index++;
    }
  }
  return code;
}

function rejectViewportHeight(css: string): void {
  const found = VIEWPORT_HEIGHT_UNIT.exec(cssCode(css))?.[0];
  if (found !== undefined)
    throw new HtmlRenderPrepareError(
      `The page uses a viewport height unit (${found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`,
    );
}

type Node = DefaultTreeAdapterMap["node"];
type Attribute = DefaultTreeAdapterMap["element"]["attrs"][number];

const imageAttributes = (tagName: string) =>
  tagName === "img" || tagName === "source"
    ? ["src"]
    : tagName === "image"
      ? ["href"]
      : tagName === "video"
        ? ["poster"]
        : [];

async function readImage(root: string, local: string): Promise<Buffer | null> {
  let file;
  try {
    file = await openContainedFile(root, path.relative(path.resolve(root), local));
  } catch {
    return null;
  }
  try {
    const size = (await file.stat()).size;
    const tooLarge = (bytes: number) =>
      new HtmlRenderPrepareError(
        `The local image ${shorten(local)} is ${mib(bytes)}; images can be at most 10 MiB. Use a smaller image.`,
      );
    if (size > MAX_IMAGE_BYTES) throw tooLarge(size);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_IMAGE_BYTES + 1 - total));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_IMAGE_BYTES) throw tooLarge(total);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}

/**
 * Checks a page, then inlines its local images through the same inode-checked
 * containment boundary as file serving. Styles are validated before any file
 * is opened.
 */
export async function prepareHtmlRender(
  html: string,
  roots: ReadonlyArray<string>,
): Promise<PreparedHtmlRender> {
  if (Buffer.byteLength(html) > HTML_RENDER_MAX_SOURCE_BYTES)
    throw new HtmlRenderPrepareError("The HTML source exceeds 512 KiB. Make the page smaller.");
  const document = parse(html);
  const pending: Node[] = [document];
  const images: Array<{ attribute: Attribute; local: string }> = [];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > MAX_NODES)
      throw new HtmlRenderPrepareError(
        `The HTML has more than ${MAX_NODES} nodes. Make the page smaller.`,
      );
    const node = pending.pop()!;
    // Reversed onto the stack, so images are listed in document order.
    if ("content" in node) pending.push(node.content);
    if ("childNodes" in node) pending.push(...node.childNodes.toReversed());
    if (!("tagName" in node)) continue;
    // The browser applies a style element's direct text, in HTML and SVG alike.
    if (node.tagName === "style")
      rejectViewportHeight(
        node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""),
      );
    const names = imageAttributes(node.tagName);
    for (const attribute of node.attrs) {
      if (attribute.name === "style") rejectViewportHeight(attribute.value);
      if (!names.includes(attribute.name)) continue;
      let local = attribute.value;
      if (local.startsWith("file:")) {
        try {
          local = fileURLToPath(local);
        } catch {
          throw new HtmlRenderPrepareError(
            `The image ${shorten(attribute.value)} is not a valid local file URL. Use an absolute path.`,
          );
        }
      }
      if (local.startsWith("//") || !path.isAbsolute(local)) continue;
      images.push({ attribute, local });
    }
  }

  const encoded = new Map<string, string | null>();
  const missing: string[] = [];
  let omitted = 0;
  let inlinedBytes = Buffer.byteLength(html);
  for (const { attribute, local } of images) {
    if (!encoded.has(local)) {
      const mime = MIMES[path.extname(local).toLowerCase()];
      if (!mime)
        throw new HtmlRenderPrepareError(
          `The local image ${shorten(local)} has an unsupported format. Use ${Object.keys(MIMES).join(", ")}.`,
        );
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
        throw new HtmlRenderPrepareError(
          `The local image ${shorten(local)} is outside the folders a page can read. Keep images inside the project, worktree or attachments.`,
        );
      const bytes = await readImage(root, local);
      if (!bytes) {
        if (missing.length < HTML_RENDER_MAX_LISTED_IMAGES) missing.push(shorten(local));
        else omitted++;
      }
      encoded.set(local, bytes ? `data:${mime};base64,${bytes.toString("base64")}` : null);
    }
    const value = encoded.get(local);
    if (!value) continue;
    inlinedBytes += Buffer.byteLength(value);
    if (inlinedBytes > HTML_RENDER_MAX_PAGE_BYTES)
      throw new HtmlRenderPrepareError(
        `With its images inlined the page is over ${mib(inlinedBytes)}; the limit is 25 MiB. Use smaller images.`,
      );
    attribute.value = value;
  }
  const prepared = serialize(document);
  const preparedBytes = Buffer.byteLength(prepared);
  if (preparedBytes > HTML_RENDER_MAX_PAGE_BYTES)
    throw new HtmlRenderPrepareError(
      `With its images inlined the page is ${mib(preparedBytes)}; the limit is 25 MiB. Use smaller images.`,
    );
  return { html: prepared, missing: { paths: missing, omitted } };
}
