import { readBoundedPages } from "./readBoundedPages.ts";
export interface CodexModelPages {
  readonly entries: ReadonlyArray<Record<string, unknown>>;
  readonly complete: boolean;
  readonly anomaly?: string;
}

/** Keep legacy includeHidden negotiation and model-list completeness unchanged. */
export async function readCodexModelPages(
  request: (params: Record<string, unknown>) => Promise<unknown>,
  { maxPages = 10 }: { maxPages?: number } = {},
): Promise<CodexModelPages> {
  let compatible = true;
  const result = await readBoundedPages({
    label: "model/list",
    maxPages,
    request: async (cursor) => {
      try {
        return await request({
          ...(compatible ? { includeHidden: true } : {}),
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (cursor || !compatible || (code !== -32601 && code !== -32602)) throw error;
        compatible = false;
        return request({});
      }
    },
    decode: (row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
      if (
        ("model" in row && typeof row.model === "string" && row.model.trim()) ||
        ("id" in row && typeof row.id === "string" && row.id.trim())
      )
        return row as Record<string, unknown>;
      return undefined;
    },
  });
  return compatible || !result.complete
    ? result
    : { ...result, complete: false, anomaly: "includeHidden unsupported" };
}
