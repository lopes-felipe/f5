export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.ok || !response.body) throw new Error("Document unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  const parts: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error("Document exceeds its size limit");
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
