export async function readBoundedPreview(
  src: string,
  signal: AbortSignal,
  limit: number,
): Promise<ArrayBuffer> {
  const response = await fetch(src, { signal });
  if (!response.ok || !response.body) throw new Error("File is unavailable.");
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("File exceeds the preview size limit.");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("File exceeds the preview size limit.");
      chunks.push(value);
    }
    return await new Blob(chunks).arrayBuffer();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
