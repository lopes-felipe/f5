const MAX_RELEASE_NOTES_LENGTH = 1_200;

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
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { readonly version?: unknown; readonly note?: unknown };
  if (typeof candidate.note !== "string") return null;
  return typeof candidate.version === "string"
    ? `${candidate.version}\n${candidate.note}`
    : candidate.note;
}

/**
 * Converts electron-updater's remote-controlled release notes into bounded
 * plain text. This intentionally never returns markup for the renderer.
 */
export function normalizeDesktopUpdateReleaseNotes(value: unknown): string | null {
  const raw = Array.isArray(value)
    ? value
        .map(releaseNoteText)
        .filter((note): note is string => note !== null)
        .join("\n\n")
    : releaseNoteText(value);
  if (!raw) return null;

  const normalized = raw
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => decodeHtmlEntity(entity))
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!normalized) return null;
  if (normalized.length <= MAX_RELEASE_NOTES_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_RELEASE_NOTES_LENGTH - 1).trimEnd()}…`;
}
