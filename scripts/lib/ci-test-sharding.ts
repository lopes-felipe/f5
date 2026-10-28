export type TestDurations = Readonly<Record<string, number>>;

const comparePath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function median(values: readonly number[]): number {
  if (!values.length) throw new Error("Cannot take the median of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function sortByDuration(files: readonly string[], durations: TestDurations): string[] {
  const values = Object.values(durations);
  if (values.some((value) => !Number.isFinite(value) || value <= 0))
    throw new Error("Test durations must be finite positive milliseconds");
  const fallback = values.length ? median(values) : 1;
  return [...files].sort(
    (a, b) => (durations[b] ?? fallback) - (durations[a] ?? fallback) || comparePath(a, b),
  );
}

/** Longest-processing-time allocation; input order and host locale cannot change membership. */
export function allocateShards(
  files: readonly string[],
  durations: TestDurations,
  count: number,
): string[][] {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid shard count");
  if (new Set(files).size !== files.length) throw new Error("Duplicate test file");
  const sorted = sortByDuration(files, durations);
  const values = Object.values(durations);
  const fallback = values.length ? median(values) : 1;
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], load: 0 }));
  for (const file of sorted) {
    const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
    lightest.files.push(file);
    lightest.load += durations[file] ?? fallback;
  }
  return shards.map((shard) => shard.files);
}
