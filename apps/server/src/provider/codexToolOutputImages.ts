const CODEX_IMAGE_DATA_URL_HEADER = /^data:(image\/[a-z0-9.+-]+);base64,/i;

export function readCodexToolOutputImage(
  item: Record<string, unknown>,
): { mimeType: string; data: string } | undefined {
  if (item.type !== "inputImage" || typeof item.imageUrl !== "string") return;
  const header = CODEX_IMAGE_DATA_URL_HEADER.exec(item.imageUrl);
  if (header?.[1]) {
    return { mimeType: header[1].toLowerCase(), data: item.imageUrl.slice(header[0].length) };
  }
}
