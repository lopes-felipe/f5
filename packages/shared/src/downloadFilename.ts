const INVALID_DOWNLOAD_FILENAME_CHARACTERS = new Set('<>:"/\\|?*');
const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
export const MAX_DOWNLOAD_FILENAME_CHARACTERS = 240;

function truncateDownloadFilename(filename: string): string {
  const characters = Array.from(filename);
  if (characters.length <= MAX_DOWNLOAD_FILENAME_CHARACTERS) {
    return filename;
  }
  const lastDot = filename.lastIndexOf(".");
  const extension = lastDot > 0 ? filename.slice(lastDot) : "";
  const extensionCharacters = Array.from(extension).slice(0, 32);
  const basenameCharacters = Array.from(lastDot > 0 ? filename.slice(0, lastDot) : filename).slice(
    0,
    MAX_DOWNLOAD_FILENAME_CHARACTERS - extensionCharacters.length,
  );
  return [...basenameCharacters, ...extensionCharacters].join("");
}

export function sanitizeDownloadFilename(name: string, fallbackName = "download"): string {
  const sanitized = Array.from(name.trim(), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 ||
      codePoint === 127 ||
      INVALID_DOWNLOAD_FILENAME_CHARACTERS.has(character)
      ? "_"
      : character;
  })
    .join("")
    .replace(/[. ]+$/u, "")
    .trim();
  if (sanitized.length === 0 || /^\.+$/u.test(sanitized)) {
    return truncateDownloadFilename(fallbackName);
  }
  const safeName = WINDOWS_RESERVED_FILENAME.test(sanitized) ? `_${sanitized}` : sanitized;
  return truncateDownloadFilename(safeName);
}
