/**
 * MCP resources in the composer. A chosen resource is held in the prompt as a
 * Markdown link, `[@<server>: <label>](mcp-resource://<server>/<uri>)`, shown as
 * a chip; on send its contents are read and appended as fenced context blocks.
 */

const REFERENCE_SCHEME = "mcp-resource://";
const MAX_LABEL_LENGTH = 60;
const REFERENCE_PATTERN = /\[@([^[\]\n]{1,200})\]\(mcp-resource:\/\/([^\s()/]+)\/([^\s()]+)\)/g;

export interface McpResourceReference {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly serverName: string;
  readonly uri: string;
  /** What the chip shows after the server name. */
  readonly label: string;
}

/** A Markdown fence longer than any backtick run inside `text`. */
export function markdownFence(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function cleanLabel(label: string): string {
  const cleaned = label
    .replace(/[[\]()\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_LABEL_LENGTH ? `${cleaned.slice(0, MAX_LABEL_LENGTH - 1)}…` : cleaned;
}

/** Percent-encodes everything that could end or break a Markdown link destination. */
function encodeReferencePart(value: string): string {
  return encodeURIComponent(value).replace(
    /[()!'*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The prompt text for one chosen resource. */
export function formatMcpResourceReference(
  serverName: string,
  resource: { readonly uri: string; readonly name?: string; readonly title?: string | undefined },
): string {
  const label = cleanLabel(resource.title || resource.name || resource.uri) || "resource";
  return `[@${cleanLabel(serverName)}: ${label}](${REFERENCE_SCHEME}${encodeReferencePart(serverName)}/${encodeReferencePart(resource.uri)})`;
}

export function mcpResourceReferenceMatches(text: string): McpResourceReference[] {
  if (!text.includes(REFERENCE_SCHEME)) return [];
  return [...text.matchAll(REFERENCE_PATTERN)].flatMap((match) => {
    try {
      const serverName = decodeURIComponent(match[2]!);
      const uri = decodeURIComponent(match[3]!);
      const prefix = `@${cleanLabel(serverName)}: `;
      const shown = `@${match[1]!}`;
      if (!serverName || !uri || !shown.startsWith(prefix)) return [];
      return [
        {
          start: match.index,
          end: match.index + match[0].length,
          raw: match[0],
          serverName,
          uri,
          label: shown.slice(prefix.length),
        },
      ];
    } catch {
      return [];
    }
  });
}

/** Each distinct resource once, in the order it first appears. */
export function uniqueMcpResourceReferences(text: string): McpResourceReference[] {
  const seen = new Set<string>();
  return mcpResourceReferenceMatches(text).filter((reference) => {
    const key = `${reference.serverName}\0${reference.uri}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface McpResourceContextPart {
  readonly serverName: string;
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly text: string;
  readonly truncated: boolean;
}

/** Cuts UTF-8 text to `bytes` without splitting a character. */
export function truncateUtf8(text: string, bytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return { text, truncated: false };
  let end = Math.max(0, bytes);
  // Step back past continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder().decode(encoded.subarray(0, end)), truncated: true };
}

/** Shares one text budget across every part of a message, in order. */
export function fitMcpResourceContext(
  parts: ReadonlyArray<McpResourceContextPart>,
  budgetBytes: number,
): McpResourceContextPart[] {
  let remaining = budgetBytes;
  return parts.map((part) => {
    const cut = truncateUtf8(part.text, remaining);
    remaining -= new TextEncoder().encode(cut.text).length;
    return cut.truncated ? { ...part, text: cut.text, truncated: true } : part;
  });
}

/** Blocks appended to a message: one per text part, noting when text was cut. */
export function formatMcpResourceContext(parts: ReadonlyArray<McpResourceContextPart>): string {
  return parts
    .map((part) => {
      const fence = markdownFence(part.text);
      const kind = part.mimeType ? ` (${part.mimeType})` : "";
      const note = part.truncated
        ? "\n[Truncated: the rest did not fit in the message's 256 KiB resource budget.]"
        : "";
      return `MCP resource ${part.uri} from ${part.serverName}${kind}:\n${fence}\n${part.text}\n${fence}${note}`;
    })
    .join("\n\n");
}
