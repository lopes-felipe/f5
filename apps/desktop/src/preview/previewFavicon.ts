const MAX_FAVICON_BYTES = 1024 * 1024;
const FAVICON_TIMEOUT_MS = 2_000;
const MAX_REDIRECTS = 3;

interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
}

export type PreviewFaviconFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly redirect: "manual" },
) => Promise<FetchResponseLike>;

function detectedMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return "image/x-icon";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = bytes.length >= 6 ? String.fromCharCode(...bytes.slice(0, 6)) : "";
  if (prefix === "GIF87a" || prefix === "GIF89a") {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
): Promise<Uint8Array | null> {
  if (!body) return null;
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_FAVICON_BYTES
  ) {
    await body.cancel().catch(() => undefined);
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_FAVICON_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchPreviewFaviconDataUrl(input: {
  readonly pageUrl: string;
  readonly candidateUrls: ReadonlyArray<string>;
  readonly fetchImplementation: PreviewFaviconFetch;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  let pageOrigin: string;
  try {
    const page = new URL(input.pageUrl);
    if (page.protocol !== "http:" && page.protocol !== "https:") return null;
    pageOrigin = page.origin;
  } catch {
    return null;
  }

  for (const rawCandidate of input.candidateUrls) {
    if (input.signal?.aborted) return null;
    let currentUrl: URL;
    try {
      currentUrl = new URL(rawCandidate, input.pageUrl);
    } catch {
      continue;
    }
    if (
      (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") ||
      currentUrl.origin !== pageOrigin
    ) {
      continue;
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), FAVICON_TIMEOUT_MS);
    timer.unref?.();
    try {
      for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
        const response = await input.fetchImplementation(currentUrl.href, {
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) break;
          const redirectUrl = new URL(location, currentUrl);
          if (redirectUrl.origin !== pageOrigin) break;
          currentUrl = redirectUrl;
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => undefined);
          break;
        }
        const bytes = await readBoundedBody(response.body, response.headers.get("content-length"));
        if (!bytes) break;
        const mimeType = detectedMimeType(bytes);
        if (!mimeType) break;
        return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
      }
    } catch {
      if (input.signal?.aborted) return null;
      // Try the next same-origin candidate.
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
  return null;
}
