import { piRecordField, piRecordString } from "./PiProtocol.ts";

export interface PiSessionEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly user: boolean;
  readonly message?: unknown;
}
export interface PiSessionTree {
  readonly entries: ReadonlyMap<string, PiSessionEntry>;
  readonly leafId: string | null;
}

const validEntryId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  value.trim() === value &&
  !value.includes("\0");

/** The listing contains abandoned branches; array order is never conversation order. */
export function parsePiSessionTree(data: unknown): PiSessionTree | null {
  const raw = piRecordField(data, "entries");
  const leafId = piRecordField(data, "leafId");
  if (!Array.isArray(raw) || raw.length > 20_000 || (leafId !== null && !validEntryId(leafId)))
    return null;
  const entries = new Map<string, PiSessionEntry>();
  for (const entry of raw) {
    const id = piRecordString(entry, "id");
    const parentId = piRecordField(entry, "parentId");
    if (!validEntryId(id) || entries.has(id) || (parentId !== null && !validEntryId(parentId)))
      return null;
    entries.set(id, {
      id,
      parentId,
      ...(piRecordField(entry, "type") === "message"
        ? { message: piRecordField(entry, "message") }
        : {}),
      user:
        piRecordField(entry, "type") === "message" &&
        piRecordString(piRecordField(entry, "message"), "role") === "user",
    });
  }
  return { entries, leafId };
}

/** Root-to-leaf active ancestry, or no evidence if any parent is missing/cyclic. */
export function piActiveBranch(tree: PiSessionTree): readonly PiSessionEntry[] | null {
  const branch: PiSessionEntry[] = [];
  const seen = new Set<string>();
  let current = tree.leafId;
  while (current !== null) {
    const entry = tree.entries.get(current);
    if (!entry || seen.has(current)) return null;
    seen.add(current);
    branch.push(entry);
    current = entry.parentId;
  }
  return branch.reverse();
}

export interface PiTurnTreeBoundary {
  /** First user entry appended by this host-owned turn, suitable for Pi's native fork. */
  readonly turnStartEntryId: string | null;
  readonly leafId: string | null;
  readonly continuationStartEntryId?: string;
  /** Present only when the old leaf still proves this is an in-session rewind. */
  readonly retainedUserEntryIds?: readonly string[];
}

export function capturePiTurnTreeBoundary(
  tree: PiSessionTree,
  previousLeaf: string | null,
): PiTurnTreeBoundary | null {
  const branch = piActiveBranch(tree);
  if (!branch || (previousLeaf !== null && !tree.entries.has(previousLeaf))) return null;
  const previousIndex =
    previousLeaf === null ? -1 : branch.findIndex((entry) => entry.id === previousLeaf);
  // A rewind discards the old boundary. Its surviving users are evidence; the current turn's start is unknown.
  if (previousLeaf !== null && previousIndex === -1)
    return {
      turnStartEntryId: null,
      leafId: tree.leafId,
      retainedUserEntryIds: branch.filter((entry) => entry.user).map((entry) => entry.id),
    };
  const appended = branch.slice(previousIndex + 1);
  const user = appended.find((entry) => entry.user);
  const message = appended.find((entry) => entry.message !== undefined);
  return {
    turnStartEntryId: user?.id ?? null,
    leafId: tree.leafId,
    ...(!user && message ? { continuationStartEntryId: message.id } : {}),
  };
}

/** A fork starts before this user entry. Missing or mismatched boundaries fail closed. */
export function piRollbackEntry(
  tree: PiSessionTree,
  discardedEntryIds: readonly string[],
): string | null {
  if (discardedEntryIds.length === 0) return null;
  const branch = piActiveBranch(tree);
  if (!branch) return null;
  const users = branch.filter((entry) => entry.user).map((entry) => entry.id);
  const suffix = users.slice(-discardedEntryIds.length);
  if (
    suffix.length !== discardedEntryIds.length ||
    suffix.some((id, index) => id !== discardedEntryIds[index])
  )
    return null;
  return suffix[0] ?? null;
}
