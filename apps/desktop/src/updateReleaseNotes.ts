const MAX_RELEASE_NOTES_LENGTH = 1_200;
const MAX_RELEASE_NOTES_INPUT_LENGTH = 8_192;
const MAX_RELEASE_NOTES_ITEMS = 64;
const MAX_RELEASE_NOTES_ITEM_LENGTH = 2_048;

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeHtmlEntity(entity: string): string {
  const named = HTML_ENTITY_REPLACEMENTS[entity];
  if (named !== undefined) return named;

  const radix = entity.startsWith("#x") ? 16 : 10;
  const digits = entity.startsWith("#x") ? entity.slice(2) : entity.slice(1);
  if (!entity.startsWith("#") || digits.length === 0) return `&${entity};`;

  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return `&${entity};`;
  }
  return String.fromCodePoint(codePoint);
}

function releaseNoteText(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, MAX_RELEASE_NOTES_ITEM_LENGTH);
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly version?: unknown; readonly note?: unknown };
  if (typeof candidate.note !== "string") return null;
  if (typeof candidate.version !== "string") {
    return candidate.note.slice(0, MAX_RELEASE_NOTES_ITEM_LENGTH);
  }
  const version = candidate.version.slice(0, 128);
  const noteBudget = Math.max(0, MAX_RELEASE_NOTES_ITEM_LENGTH - version.length - 1);
  return `${version}\n${candidate.note.slice(0, noteBudget)}`;
}

function boundedReleaseNotesInput(value: unknown): string | null {
  if (!Array.isArray(value)) return releaseNoteText(value);
  const chunks: string[] = [];
  let length = 0;
  for (const entry of value.slice(0, MAX_RELEASE_NOTES_ITEMS)) {
    const note = releaseNoteText(entry);
    if (note === null) continue;
    const separatorLength = chunks.length === 0 ? 0 : 2;
    const remaining = MAX_RELEASE_NOTES_INPUT_LENGTH - length - separatorLength;
    if (remaining <= 0) break;
    const chunk = note.slice(0, remaining);
    chunks.push(chunk);
    length += separatorLength + chunk.length;
    if (chunk.length < note.length || length >= MAX_RELEASE_NOTES_INPUT_LENGTH) break;
  }
  return chunks.length > 0 ? chunks.join("\n\n") : null;
}

/**
 * Converts electron-updater's remote-controlled release notes into bounded
 * plain text. This intentionally never returns markup for the renderer.
 */
export function normalizeDesktopUpdateReleaseNotes(value: unknown): string | null {
  const raw = boundedReleaseNotesInput(value);
  if (!raw) return null;

  const normalized = raw
    .slice(0, MAX_RELEASE_NOTES_INPUT_LENGTH)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => decodeHtmlEntity(entity))
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!normalized) return null;
  if (normalized.length <= MAX_RELEASE_NOTES_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_RELEASE_NOTES_LENGTH - 1).trimEnd()}…`;
}
