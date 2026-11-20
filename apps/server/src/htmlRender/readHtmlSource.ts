import path from "node:path";
import { realpath } from "node:fs/promises";
import { HTML_RENDER_MAX_SOURCE_BYTES } from "@t3tools/contracts";
import { isNetworkPath } from "@t3tools/shared/path";
import { openContainedFile } from "../assetHttp.ts";
export class HtmlSourceError extends Error {}

/** Read once from the checked inode; published pages never refer back to this mutable file. */
export async function readHtmlSource(
  source: { readonly html?: string | undefined; readonly path?: string | undefined },
  runtimeMode: string,
  internalPaths: readonly string[],
): Promise<string> {
  if ((source.html === undefined) === (source.path === undefined))
    throw new HtmlSourceError("Pass exactly one of html or path.");
  if (source.html !== undefined) return source.html;
  if (runtimeMode !== "full-access")
    throw new HtmlSourceError(
      "Pass html instead of path: only full-access threads may pass a path.",
    );
  const filePath = source.path!;
  const invalid = () =>
    new HtmlSourceError(
      "Pass an absolute path to a regular .html file that starts with <!doctype html> or <html>.",
    );
  if (!path.isAbsolute(filePath) || isNetworkPath(filePath)) throw invalid();
  const unreadable = () =>
    new HtmlSourceError(
      "The HTML file was not found or is unreadable. Check the absolute file path and permissions.",
    );
  const resolved = await realpath(filePath).catch(() => {
    throw unreadable();
  });
  if (isNetworkPath(resolved) || !/\.html?$/i.test(resolved)) throw invalid();
  for (const internal of internalPaths) {
    const root = await realpath(internal).catch(() => path.resolve(internal));
    const relative = path.relative(root, resolved);
    if (
      !relative ||
      (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
    )
      throw invalid();
  }
  const file = await openContainedFile(path.dirname(resolved), path.basename(resolved)).catch(
    () => {
      throw unreadable();
    },
  );
  try {
    const stat = await file.stat();
    if (stat.nlink !== 1 || stat.size > HTML_RENDER_MAX_SOURCE_BYTES) throw invalid();
    const buffer = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    const html = buffer.toString("utf8", 0, filled);
    if (!/^\s*<(?:!doctype\s+html|html)[\s>]/i.test(html)) throw invalid();
    return html;
  } finally {
    await file.close();
  }
}
