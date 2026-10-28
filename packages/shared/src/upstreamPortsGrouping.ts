import { UPSTREAM_PORT_BATCH_SIZE_DEFAULT, type UpstreamPortGrouping } from "@t3tools/contracts";

export const normalizeArea = (area: string): string =>
  area
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/gu, "-");

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

export function portFileKeys(
  fileSetsByTopic: ReadonlyMap<string, ReadonlyArray<string> | null>,
  options: { readonly dropHotPaths?: boolean } = {},
): {
  keysByTopic: Map<string, string[] | null>;
  hotPaths: Set<string>;
} {
  const counts = new Map<string, number>();
  for (const paths of fileSetsByTopic.values())
    for (const path of new Set(paths ?? [])) counts.set(path, (counts.get(path) ?? 0) + 1);
  const hotPaths = new Set(
    [...counts]
      .filter(
        ([, count]) =>
          options.dropHotPaths !== false && count >= 10 && count >= fileSetsByTopic.size * 0.05,
      )
      .map(([path]) => path),
  );
  return {
    hotPaths,
    keysByTopic: new Map(
      [...fileSetsByTopic].map(([id, paths]) => [
        id,
        paths === null
          ? null
          : [...new Set(paths)].filter(
              (path) => !LOCKFILES.has(path.split("/").at(-1)!) && !hotPaths.has(path),
            ),
      ]),
    ),
  };
}

export interface PortGroupingTopic {
  readonly id: string;
  readonly area: string;
  readonly related: ReadonlyArray<string>;
  readonly fileKeys: ReadonlyArray<string> | null;
}

export function filesOverlap(a: Iterable<string>, b: Iterable<string>): boolean {
  const keys = new Set(a);
  for (const key of b) if (keys.has(key)) return true;
  return false;
}

/** Stable union-find clustering, followed by area-local first-fit packing. */
export function groupPortTopics(
  input: ReadonlyArray<PortGroupingTopic>,
  grouping: UpstreamPortGrouping,
  batchSize = UPSTREAM_PORT_BATCH_SIZE_DEFAULT,
): string[][] {
  const topics = [...new Map(input.map((topic) => [topic.id, topic])).values()];
  if (topics.length === 0) return [];
  if (grouping === "together") return [topics.map((topic) => topic.id)];
  if (grouping === "separately") return topics.map((topic) => [topic.id]);
  if (!Number.isInteger(batchSize) || batchSize < 2 || batchSize > 10)
    throw new Error("Port batch size must be between 2 and 10.");
  const parents = topics.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const join = (a: number, b: number) => {
    const ra = root(a),
      rb = root(b);
    parents[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const indices = new Map(topics.map((topic, index) => [topic.id, index]));
  const fileOwner = new Map<string, number>();
  for (const [index, topic] of topics.entries()) {
    // Missing evidence stays an area-only singleton, including related edges.
    if (topic.fileKeys === null) continue;
    for (const id of topic.related) {
      const other = indices.get(id);
      if (other !== undefined && topics[other]!.fileKeys !== null) join(index, other);
    }
    for (const key of topic.fileKeys) {
      const owner = fileOwner.get(key);
      if (owner !== undefined) join(index, owner);
      else fileOwner.set(key, index);
    }
  }
  const clusters = new Map<number, PortGroupingTopic[]>();
  for (const [index, topic] of topics.entries()) {
    const key = root(index);
    const cluster = clusters.get(key) ?? [];
    cluster.push(topic);
    clusters.set(key, cluster);
  }
  const groups: Array<{ area: string; ids: string[]; packable: boolean }> = [];
  for (const cluster of clusters.values()) {
    const area = normalizeArea(cluster[0]!.area);
    if (cluster.length >= batchSize) {
      for (let offset = 0; offset < cluster.length; offset += batchSize)
        groups.push({
          area,
          ids: cluster.slice(offset, offset + batchSize).map((topic) => topic.id),
          packable: false,
        });
      continue;
    }
    const group = groups.find(
      (entry) =>
        entry.packable && entry.area === area && entry.ids.length + cluster.length <= batchSize,
    );
    if (group) group.ids.push(...cluster.map((topic) => topic.id));
    else groups.push({ area, ids: cluster.map((topic) => topic.id), packable: true });
  }
  const order = new Map(topics.map((topic, index) => [topic.id, index]));
  return groups.map(({ ids }) => ids.toSorted((a, b) => order.get(a)! - order.get(b)!));
}
