export function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function getSafeBrowserLoginUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length > 4096) return null;
  const safe = getSafeExternalUrl(rawUrl);
  if (!safe || safe.length > 4096) return null;
  const parsed = new URL(safe);
  return parsed.username || parsed.password ? null : safe;
}
