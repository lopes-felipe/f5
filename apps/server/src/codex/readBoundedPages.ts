export interface BoundedPages<T> {
  readonly entries: ReadonlyArray<T>;
  readonly complete: boolean;
  readonly anomaly?: string;
}

/** Shared traversal. A partial listing never proves an entry absent. */
export async function readBoundedPages<T>(input: {
  request: (cursor: string | undefined, remainingMs: number) => Promise<unknown>;
  decode: (row: unknown) => T | undefined;
  label: string;
  maxPages?: number;
  maxItems?: number;
  maxPageItems?: number;
  initialFailureIsPartial?: boolean;
  signal?: AbortSignal;
  deadline?: number;
  allowMissingCursor?: boolean;
}): Promise<BoundedPages<T>> {
  const entries: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const partial = (anomaly: string): BoundedPages<T> => ({
    entries,
    complete: false,
    anomaly: `${input.label} ${anomaly}`,
  });
  for (let page = 0; page < (input.maxPages ?? 10); page++) {
    const remaining = (input.deadline ?? Infinity) - Date.now();
    if (input.signal?.aborted || remaining <= 0) return partial("cancelled or timed out");
    let response: unknown;
    try {
      response = await input.request(cursor, remaining);
    } catch (error) {
      if (!page && !input.initialFailureIsPartial) throw error;
      return partial("page request failed");
    }
    if (input.signal?.aborted || Date.now() >= (input.deadline ?? Infinity))
      return partial("cancelled or timed out");
    if (
      !response ||
      typeof response !== "object" ||
      !("data" in response) ||
      !Array.isArray(response.data)
    )
      return partial("has malformed data");
    for (const row of response.data.slice(0, input.maxPageItems ?? response.data.length)) {
      const decoded = input.decode(row);
      if (decoded === undefined) return partial("has a malformed row");
      if (entries.length >= (input.maxItems ?? Infinity)) return partial("item limit reached");
      entries.push(decoded);
    }
    if (response.data.length > (input.maxPageItems ?? Infinity))
      return partial("page item limit exceeded");
    const next = "nextCursor" in response ? response.nextCursor : undefined;
    if (next === null || (input.allowMissingCursor && next === undefined))
      return { entries, complete: true };
    if (typeof next !== "string" || !next || seen.has(next))
      return partial("has an invalid or repeated cursor");
    seen.add(next);
    cursor = next;
  }
  return partial("page limit reached");
}
