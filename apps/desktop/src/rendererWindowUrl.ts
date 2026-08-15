const MAX_THREAD_ID_LENGTH = 256;

export function normalizeThreadIdForDesktopWindow(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const threadId = value.trim();
  if (
    threadId.length === 0 ||
    threadId.length > MAX_THREAD_ID_LENGTH ||
    threadId.includes("\0") ||
    threadId.includes("/") ||
    threadId.includes("\\")
  ) {
    return null;
  }
  return threadId;
}

export function rendererUrlForThread(baseUrl: string, threadId: string | null): string {
  if (!threadId) return baseUrl;
  const hashIndex = baseUrl.indexOf("#");
  const withoutHash = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  return `${withoutHash}#/${encodeURIComponent(threadId)}`;
}
