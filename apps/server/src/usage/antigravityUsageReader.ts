// SQLite reads live conversation databases while Node fs discovers them.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import type { NativeUsageRecord } from "./nativeUsageRecord.ts";
import { openRuntimeSqliteDatabase } from "../persistence/runtimeSqlite.ts";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

/** Antigravity stores usage metadata as protobuf, independently of conversation text. */
function fields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid protobuf field length");
      if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
};
const bytesAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
};
const nested = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? new Map<number, FieldValue[]>() : fields(bytes);
};
const textAt = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
};
const timestamp = (value: Fields) => {
  const seconds = numberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null;
};

const MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
  1427: "gemini-4-carbon",
  1437: "gemini-4-carbon",
  1525: "gemini-4-hydrogen",
  1526: "gemini-4-hydrogen",
  1527: "gemini-4-hydrogen",
  1532: "gemini-4-neon",
  1533: "gemini-4-neon",
  1537: "gemini-4-neon",
  1667: "gemini-4-carbon",
  1669: "gemini-4-hydrogen",
};

const GEMINI_ROUTING_MODELS: Readonly<Record<string, string>> = {
  "gemini-pro-orchestrator-neon": "gemini-4-neon",
  "gemini-pro-orchestrator-g1-pro": "gemini-4-argon",
  "gemini-pro-orchestrator": "gemini-4-carbon",
};

function modelName(name: string, id: number): string {
  if (name) {
    const normalized = name
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replaceAll(" ", "-");
    if (normalized.startsWith("claude-")) {
      return normalized
        .replace(/^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
        .replaceAll(".", "-")
        .replace(/-(?:extra-low|low|medium|high|thinking)$/, "");
    }
    if (normalized.startsWith("gemini-")) {
      if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(normalized))
        return "gemini-3-flash-preview";
      const base = normalized.replace(
        /-(?:extra-low|low|medium|high|tiered|control|thinking|agent|orchestrator|trial|n|r)$/,
        "",
      );
      return (
        GEMINI_ROUTING_MODELS[normalized] ??
        (base === "gemini-3-flash" ? "gemini-3-flash-preview" : base)
      );
    }
    return normalized;
  }
  return MODEL_IDS[id] ?? (id > 0 ? `antigravity-model-${id}` : "");
}

interface Metadata {
  model: string;
  namedModelId: number;
  timestampMs: number | null;
  usages: Fields[];
}

function metadata(bytes: Uint8Array, step: boolean): Metadata {
  const root = fields(bytes);
  if (!step && bytesAt(root, 1) === undefined) {
    throw new Error("Missing Antigravity generation metadata");
  }
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const usage = bytesAt(data, step ? 9 : 4);
  const usages = usage === undefined ? [] : [fields(usage)];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== undefined) usages.push(fields(retryUsage));
  }
  const name = textAt(model, step ? 12 : 19) || textAt(model, step ? 8 : 21);
  const id = numberAt(model, step ? 1 : 3);
  return {
    model: modelName(name, id),
    namedModelId: name ? id : 0,
    timestampMs: step
      ? (timestamp(nested(data, 8)) ?? timestamp(nested(data, 1)))
      : timestamp(nested(nested(data, 9), 4)),
    usages,
  };
}

function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Antigravity metadata blob");
  return value;
}

interface UsageCandidate {
  record: NativeUsageRecord;
  keys: readonly string[];
  timestampQuality: number;
}

async function readDatabase(
  path: string,
  fallbackTimestamp: number,
  namedModels: Map<number, string | null>,
  signal?: AbortSignal,
  onInvalidRecord?: () => void,
): Promise<UsageCandidate[]> {
  const db = (await openRuntimeSqliteDatabase(path, {
    readOnly: true,
  })) as unknown as NodeSqlite.DatabaseSync;
  try {
    db.exec("PRAGMA busy_timeout = 100; BEGIN");
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    if (!tables.has("gen_metadata") && !tables.has("steps")) {
      throw new Error("Missing Antigravity usage tables");
    }
    const readMetadata = async (query: string, column: string, step: boolean) => {
      const entries: Array<{ idx: number; entry: Metadata }> = [];
      for (const row of db.prepare(query).iterate()) {
        signal?.throwIfAborted();
        try {
          if (typeof row.idx !== "number") throw new Error("Invalid Antigravity metadata index");
          entries.push({ idx: row.idx, entry: metadata(blob(row[column]), step) });
        } catch {
          onInvalidRecord?.();
        }
        if (entries.length % 256 === 0) await NodeTimersPromises.setImmediate();
      }
      return entries;
    };
    const generations = tables.has("gen_metadata")
      ? await readMetadata("SELECT idx, data FROM gen_metadata ORDER BY idx", "data", false)
      : [];
    let trajectoryTimestamp: number | null = null;
    if (tables.has("trajectory_metadata_blob")) {
      for (const row of db.prepare("SELECT data FROM trajectory_metadata_blob").iterate()) {
        trajectoryTimestamp ??= timestamp(nested(fields(blob(row.data)), 2));
      }
    }
    const steps = tables.has("steps")
      ? await readMetadata(
          "SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx",
          "metadata",
          true,
        )
      : [];
    const sessionId = NodePath.basename(path, ".db");
    const records: UsageCandidate[] = [];
    const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry.model]));
    for (const entries of [generations, steps]) {
      for (const { entry } of entries) {
        if (!entry.namedModelId) continue;
        const previous = namedModels.get(entry.namedModelId);
        if (previous === undefined) namedModels.set(entry.namedModelId, entry.model);
        else if (previous !== entry.model) namedModels.set(entry.namedModelId, null);
      }
    }
    for (const [source, entries] of [
      ["step", steps],
      ["generation", generations],
    ] as const) {
      for (const [index, { idx, entry }] of entries.entries()) {
        for (const [usageIndex, usage] of entry.usages.entries()) {
          const outputTokens = Math.max(
            numberAt(usage, 3),
            numberAt(usage, 9) + numberAt(usage, 10),
          );
          const totals = {
            uncachedInputTokens: numberAt(usage, 2),
            cachedInputTokens: numberAt(usage, 5),
            cacheCreationTokens: numberAt(usage, 4),
            outputTokens,
            reasoningTokens: Math.min(outputTokens, numberAt(usage, 9)),
          };
          if (
            totals.uncachedInputTokens +
              totals.cachedInputTokens +
              totals.cacheCreationTokens +
              outputTokens ===
            0
          )
            continue;
          const keys = ([11, 12, 7] as const).flatMap((key) => {
            const id = textAt(usage, key);
            return id ? [`antigravity:${key}:${id}`] : [];
          });
          const record: NativeUsageRecord = {
            provider: "antigravity",
            sessionId,
            timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
            model:
              MODEL_IDS[numberAt(usage, 1)] ||
              entry.model ||
              (source === "step" ? generationModels.get(idx) : "") ||
              modelName("", numberAt(usage, 1)) ||
              "antigravity-unknown",
            totals,
            reportedCostUsd: null,
            dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`,
          };
          records.push({
            record,
            keys,
            timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
          });
        }
      }
    }
    return records;
  } finally {
    db.close();
  }
}

/** Reads and merges aliases across every configured Antigravity store before date filtering. */
export async function readAntigravityUsage(
  conversationsDirectories: string | readonly string[],
  sinceMs: number,
  signal?: AbortSignal,
) {
  const roots =
    typeof conversationsDirectories === "string"
      ? [conversationsDirectories]
      : conversationsDirectories;
  const files: Array<{ root: string; path: string; records: NativeUsageRecord[] }> = [];
  const errors: string[] = [];
  const identities = new Map<string, number>();
  const namedModels = new Map<number, string | null>();
  const groups: Array<
    UsageCandidate & { parent: number; size: number; owner: number; fileIndex: number }
  > = [];
  const find = (index: number): number => {
    let root = index;
    while (groups[root]!.parent !== root) root = groups[root]!.parent;
    while (index !== root) {
      const parent = groups[index]!.parent;
      groups[index]!.parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left: number, right: number): number => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a]!.size < groups[b]!.size) [a, b] = [b, a];
    const target = groups[a]!;
    const source = groups[b]!;
    const first = target.owner < source.owner ? target : source;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality &&
        source.record.timestampMs < target.record.timestampMs)
        ? source
        : target;
    const x = target.record.totals;
    const y = source.record.totals;
    target.record = {
      ...first.record,
      model:
        first.record.model === "antigravity-unknown"
          ? first === target
            ? source.record.model
            : target.record.model
          : first.record.model,
      timestampMs: bestTime.record.timestampMs,
      totals: {
        uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
        cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
        cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
        outputTokens: Math.max(x.outputTokens, y.outputTokens),
        reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
      },
    };
    target.timestampQuality = bestTime.timestampQuality;
    target.owner = first.owner;
    target.fileIndex = first.fileIndex;
    target.size += source.size;
    source.parent = a;
    return a;
  };
  const append = (candidate: UsageCandidate, fileIndex: number) => {
    const index = groups.length;
    groups.push({ ...candidate, parent: index, size: 1, owner: index, fileIndex });
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) merge(index, existing);
      identities.set(key, index);
    }
  };
  const visited = new Set<string>();
  const walk = async (directory: string, root: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(directory);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, root);
      } else if (entry.isFile() && entry.name.endsWith(".db")) {
        try {
          const canonical = await NodeFSP.realpath(path);
          if (visited.has(canonical)) continue;
          visited.add(canonical);
          const stat = await NodeFSP.stat(path);
          if (stat.mtimeMs < sinceMs) {
            const wal = await NodeFSP.stat(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return null;
            });
            if (!wal || wal.mtimeMs < sinceMs) continue;
          }
          let partial = false;
          const candidates = await readDatabase(path, stat.mtimeMs, namedModels, signal, () => {
            partial = true;
          });
          if (partial) errors.push(path);
          const fileIndex = files.length;
          files.push({ root, path, records: [] });
          for (const [index, candidate] of candidates.entries()) {
            append(candidate, fileIndex);
            if (index % 256 === 255) await NodeTimersPromises.setImmediate();
          }
        } catch {
          errors.push(path);
        }
      }
    }
  };
  for (const root of roots) await walk(root, root);
  for (const [index, group] of groups.entries()) {
    if (group.parent === index && group.record.timestampMs >= sinceMs) {
      const id = /^antigravity-model-(\d+)$/.exec(group.record.model)?.[1];
      const namedModel = id === undefined ? undefined : namedModels.get(Number(id));
      files[group.fileIndex]!.records.push(
        namedModel ? { ...group.record, model: namedModel } : group.record,
      );
    }
  }
  signal?.throwIfAborted();
  return { files, errors };
}
