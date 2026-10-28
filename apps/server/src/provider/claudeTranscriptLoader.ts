/**
 * A replica of how the Claude CLI 2.1.295 loader turns a transcript into the
 * conversation it resumes. `--resume-session-at` only searches that
 * conversation, so a UUID elsewhere in the file is "not found".
 *
 * The loader, in file order:
 * - skips `progress` records and forwards their children's parent links past them;
 * - drops user and assistant rows whose message it cannot read, reparenting
 *   their children the same way;
 * - tracks the last row and the last `last-prompt` checkpoint. A later row
 *   clears a checkpoint's explicit flag, and a compaction clears the checkpoint.
 *
 * Then it relinks the last compaction's preserved segment, drops the history
 * before it, and picks the leaf message to resume from.
 */

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

interface LoaderRow {
  readonly uuid: string;
  parentUuid: string | null;
  readonly type: string;
  readonly isSidechain: boolean;
  readonly isMeta: boolean;
  readonly timestamp: string | undefined;
  readonly forkBriefing: boolean;
  readonly compactBoundary: boolean;
  readonly compactMetadata: Record<string, unknown> | undefined;
  readonly messageId: string | undefined;
  readonly hasToolUse: boolean;
  readonly hasToolResult: boolean;
  readonly toolUseIds: ReadonlyArray<string>;
  readonly toolResultIds: ReadonlyArray<string>;
  readonly attachmentToolUseId: string | undefined;
}

export interface ClaudeTranscriptView {
  /** Parent links after progress forwarding and compaction relinking. */
  readonly parents: ReadonlyMap<string, string | null>;
  /** The message the CLI resumes from, if it can pick one. */
  readonly leaf: string | undefined;
  /** The leaf's parent chain: the conversation the CLI loads. */
  readonly chain: ReadonlySet<string>;
  /** The row the leaf was found from, and whether that row was the checkpoint. */
  readonly start: string | undefined;
  readonly pickedCheckpoint: boolean;
  /** The checkpoint in effect, which repair may drop when it pins an older turn. */
  readonly checkpoint: string | undefined;
}

const LOADED_TYPES = new Set(["user", "assistant", "attachment", "system"]);
const isMessage = (row: LoaderRow) => row.type === "user" || row.type === "assistant";

function blockIds(content: unknown, type: string, key: string): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type === type && typeof block[key] === "string") ids.push(block[key]);
  }
  return ids;
}

const hasBlock = (content: unknown, type: string) =>
  Array.isArray(content) && content.some((value) => asRecord(value)?.type === type);

/** The CLI drops user and assistant rows whose content it cannot read. */
function isUnreadable(entry: Record<string, unknown>): boolean {
  const message = asRecord(entry.message);
  if (!message) return true;
  const content = message.content;
  if (typeof content === "string") return entry.type === "assistant" && content.trim() === "";
  if (!Array.isArray(content)) return true;
  return content.length > 0 && !content.some((block) => typeof asRecord(block)?.type === "string");
}

function loaderRow(entry: Record<string, unknown>, uuid: string, parentUuid: string | null) {
  const type = entry.type as string;
  const message = asRecord(entry.message);
  const attachment = asRecord(entry.attachment);
  const metadata = asRecord(entry.compactMetadata);
  return {
    uuid,
    parentUuid,
    type,
    isSidechain: Boolean(entry.isSidechain),
    isMeta: entry.isMeta === true,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
    forkBriefing: type === "attachment" && attachment?.type === "fork_briefing",
    compactBoundary: type === "system" && entry.subtype === "compact_boundary",
    compactMetadata:
      metadata?.preservedMessages || metadata?.preservedSegment ? metadata : undefined,
    messageId: typeof message?.id === "string" && message.id ? message.id : undefined,
    hasToolUse: hasBlock(message?.content, "tool_use"),
    hasToolResult: hasBlock(message?.content, "tool_result"),
    toolUseIds: type === "assistant" ? blockIds(message?.content, "tool_use", "id") : [],
    toolResultIds: type === "user" ? blockIds(message?.content, "tool_result", "tool_use_id") : [],
    attachmentToolUseId:
      type === "attachment" && typeof attachment?.toolUseID === "string"
        ? attachment.toolUseID
        : undefined,
  } satisfies LoaderRow;
}

const parentRow = (rows: ReadonlyMap<string, LoaderRow>, row: LoaderRow | undefined) =>
  row?.parentUuid ? rows.get(row.parentUuid) : undefined;

/** Rows the CLI treats as part of one streamed message, such as hooks and tool results. */
function continuesMessage(row: LoaderRow, messageId: string): boolean {
  switch (row.type) {
    case "assistant":
      return row.messageId === messageId;
    case "user":
      return row.isMeta || row.hasToolResult;
    case "attachment":
      return true;
    case "system":
      return !row.compactBoundary;
    default:
      return false;
  }
}

const isSideRow = (row: LoaderRow) =>
  row.type === "attachment" ||
  (row.type === "system" && !row.compactBoundary) ||
  (row.type === "user" && row.isMeta && !row.hasToolResult);

function sameMessageAncestors(
  rows: ReadonlyMap<string, LoaderRow>,
  row: LoaderRow,
  messageId: string,
): LoaderRow[] {
  const found: LoaderRow[] = [];
  const seen = new Set([row.uuid]);
  let current = parentRow(rows, row);
  while (current && !seen.has(current.uuid) && continuesMessage(current, messageId)) {
    seen.add(current.uuid);
    found.push(current);
    current = parentRow(rows, current);
  }
  return found;
}

/**
 * Whether `from` continues the conversation at `ancestor`. Directly means
 * `ancestor` is on its parent chain. Through a batch also counts the sibling
 * rows the CLI writes for parallel tool calls of one assistant message.
 */
function continuesFrom(
  rows: ReadonlyMap<string, LoaderRow>,
  from: string,
  ancestor: string,
  direct: boolean,
  throughBatch: boolean,
): boolean {
  let batch: LoaderRow | undefined;
  let results: ReadonlyArray<string> = [];
  let viaAttachment = false;
  if (throughBatch) {
    const seen = new Set<string>();
    let side: LoaderRow | undefined;
    let current = rows.get(ancestor);
    while (current && isSideRow(current) && !seen.has(current.uuid)) {
      seen.add(current.uuid);
      side = current;
      current = parentRow(rows, current);
    }
    if (current?.type === "user" && current.hasToolResult) {
      results = current.toolResultIds;
      batch = parentRow(rows, current);
    } else if (side) {
      const toolUseId = side.attachmentToolUseId;
      const messageId = current?.type === "assistant" ? current.messageId : undefined;
      batch =
        current && messageId && toolUseId !== undefined
          ? [current, ...sameMessageAncestors(rows, current, messageId)].find((row) =>
              row.toolUseIds.includes(toolUseId),
            )
          : undefined;
      results = batch && toolUseId !== undefined ? [toolUseId] : [];
      viaAttachment = results.length > 0;
    } else batch = current;
  }
  const toolUses = batch?.toolUseIds ?? [];
  const messageId =
    batch?.type === "assistant" && toolUses.length > 0 ? batch.messageId : undefined;
  const siblings = new Set(
    batch && messageId ? sameMessageAncestors(rows, batch, messageId).map((row) => row.uuid) : [],
  );
  const seen = new Set<string>();
  let previous: LoaderRow | undefined;
  let inBatch = false;
  let cursor: string | undefined = from;
  while (cursor !== undefined && !seen.has(cursor)) {
    if (direct && cursor === ancestor) return true;
    seen.add(cursor);
    const row = rows.get(cursor);
    if (batch && messageId && row) {
      if (inBatch && row.uuid === batch.uuid) return true;
      if (
        row.type === "assistant" &&
        row.uuid !== batch.uuid &&
        row.messageId === messageId &&
        row.hasToolUse
      ) {
        if (siblings.has(row.uuid)) return true;
        inBatch = true;
      } else if (!continuesMessage(row, messageId)) inBatch = false;
    }
    if (
      batch &&
      row?.uuid === batch.uuid &&
      previous &&
      results.some((id) => toolUses.includes(id)) &&
      previous.toolResultIds.some(
        (id) =>
          toolUses.includes(id) && (viaAttachment ? toolUses.length > 1 : !results.includes(id)),
      )
    )
      return true;
    previous = row;
    cursor = row?.parentUuid ?? undefined;
  }
  return false;
}

function nearestMessage(rows: ReadonlyMap<string, LoaderRow>, start: string): string | undefined {
  const seen = new Set<string>();
  for (let row = rows.get(start); row && !seen.has(row.uuid); row = parentRow(rows, row)) {
    seen.add(row.uuid);
    if (isMessage(row)) return row.uuid;
  }
  return undefined;
}

/** The message ending each branch: the nearest message above a childless row. */
function leafMessages(rows: ReadonlyMap<string, LoaderRow>): Set<string> {
  const parents = new Set<string>();
  const messageParents = new Set<string>();
  for (const row of rows.values()) {
    if (row.parentUuid === null) continue;
    parents.add(row.parentUuid);
    if (isMessage(row)) messageParents.add(row.parentUuid);
  }
  const leaves = new Set<string>();
  for (const row of rows.values()) {
    if (parents.has(row.uuid)) continue;
    const seen = new Set<string>();
    for (let current: LoaderRow | undefined = row; current; current = parentRow(rows, current)) {
      if (seen.has(current.uuid)) break;
      seen.add(current.uuid);
      if (isMessage(current)) {
        if (!messageParents.has(current.uuid)) leaves.add(current.uuid);
        break;
      }
    }
  }
  return leaves;
}

/** The preserved UUIDs of a compaction, head first, if all of them can be found. */
function preservedSegment(
  rows: ReadonlyMap<string, LoaderRow>,
  metadata: Record<string, unknown>,
): { anchorUuid: string; uuids: string[] } | undefined {
  const listed = asRecord(metadata.preservedMessages);
  if (metadata.preservedMessages) {
    return typeof listed?.anchorUuid === "string" &&
      Array.isArray(listed.uuids) &&
      listed.uuids.every((uuid) => typeof uuid === "string")
      ? { anchorUuid: listed.anchorUuid, uuids: listed.uuids as string[] }
      : undefined;
  }
  const segment = asRecord(metadata.preservedSegment);
  if (typeof segment?.anchorUuid !== "string" || typeof segment.tailUuid !== "string") return;
  const uuids: string[] = [];
  const seen = new Set<string>();
  for (
    let row = rows.get(segment.tailUuid);
    row && !seen.has(row.uuid);
    row = parentRow(rows, row)
  ) {
    seen.add(row.uuid);
    uuids.push(row.uuid);
    if (row.uuid === segment.headUuid)
      return { anchorUuid: segment.anchorUuid, uuids: uuids.reverse() };
  }
  return undefined;
}

/**
 * Relink the preserved segment of the last compaction under its anchor and drop
 * the history before that compaction. Returns the segment's tail, or undefined
 * when there is nothing to relink.
 */
function relinkCompaction(rows: Map<string, LoaderRow>): string | undefined {
  let metadata: Record<string, unknown> | undefined;
  let metadataIndex = -1;
  let boundaryIndex = -1;
  const order = new Map<string, number>();
  let index = 0;
  for (const row of rows.values()) {
    order.set(row.uuid, index);
    if (row.compactBoundary) {
      boundaryIndex = index;
      if (row.compactMetadata) {
        metadata = row.compactMetadata;
        metadataIndex = index;
      }
    }
    index++;
  }
  if (!metadata) return undefined;
  const isLast = metadataIndex === boundaryIndex;
  const found = isLast ? preservedSegment(rows, metadata) : undefined;
  if (isLast && !found) return undefined;
  const preserved = found && found.uuids.length > 0 ? found : undefined;
  if (preserved?.uuids.some((uuid) => !rows.has(uuid))) return undefined;
  const uuids = preserved?.uuids ?? [];
  const tail = uuids.at(-1) ?? null;
  if (preserved) {
    let parent = preserved.anchorUuid;
    for (const uuid of uuids) {
      rows.get(uuid)!.parentUuid = parent;
      parent = uuid;
    }
    for (const [uuid, row] of rows)
      if (row.parentUuid === preserved.anchorUuid && uuid !== uuids[0]) row.parentUuid = tail;
  }
  const kept = new Set(uuids);
  const dropped = [...rows.keys()].filter(
    (uuid) => order.get(uuid)! < boundaryIndex && !kept.has(uuid),
  );
  for (const uuid of dropped) rows.delete(uuid);
  if (preserved && dropped.length > 0) {
    const removed = new Set(dropped);
    for (const row of rows.values())
      if (isMessage(row) && row.parentUuid !== null && removed.has(row.parentUuid))
        row.parentUuid = tail;
  }
  return tail ?? undefined;
}

export class ClaudeTranscriptLoader {
  private readonly rows = new Map<string, LoaderRow>();
  private readonly forwarded = new Map<string, string | null>();
  private readonly unreadable = new Map<string, string | null>();
  private lastRow: string | undefined;
  private newestRow: string | undefined;
  private newestTime = "";
  private checkpoint: string | undefined;
  private explicit = false;
  private everExplicit = false;
  private sawCheckpoint = false;
  private cleared = false;

  /** `lenient` keeps rows without a readable message, for indexes built without payloads. */
  constructor(private readonly lenient = false) {}

  add(value: unknown): void {
    const entry = asRecord(value);
    if (!entry) return;
    const declaredParent = typeof entry.parentUuid === "string" ? entry.parentUuid : null;
    if (entry.type === "progress" && typeof entry.uuid === "string") {
      this.forwarded.set(
        entry.uuid,
        declaredParent !== null && this.forwarded.has(declaredParent)
          ? (this.forwarded.get(declaredParent) ?? null)
          : declaredParent,
      );
      return;
    }
    if (typeof entry.type === "string" && LOADED_TYPES.has(entry.type)) {
      if (typeof entry.uuid !== "string") return;
      const parent =
        declaredParent !== null && this.forwarded.has(declaredParent)
          ? (this.forwarded.get(declaredParent) ?? null)
          : declaredParent;
      if (
        !this.lenient &&
        (entry.type === "user" || entry.type === "assistant") &&
        isUnreadable(entry)
      ) {
        if (!this.rows.has(entry.uuid)) this.unreadable.set(entry.uuid, parent);
        return;
      }
      const row = loaderRow(entry, entry.uuid, parent);
      this.rows.set(row.uuid, row);
      if (!row.isSidechain && !row.forkBriefing) {
        this.lastRow = row.uuid;
        if (row.timestamp !== undefined && row.timestamp > this.newestTime) {
          this.newestRow = row.uuid;
          this.newestTime = row.timestamp;
        }
        this.explicit = false;
        this.cleared = false;
      }
      if (row.compactBoundary) {
        this.checkpoint = undefined;
        this.explicit = false;
        this.everExplicit = false;
      }
      return;
    }
    if (entry.type !== "last-prompt") return;
    if (entry.leafUuid !== undefined) this.sawCheckpoint = true;
    if (typeof entry.leafUuid === "string" && entry.leafUuid) {
      const same = entry.leafUuid === this.checkpoint;
      this.explicit = entry.explicit === true || (this.explicit && same);
      this.everExplicit = entry.explicit === true || (this.everExplicit && same);
      this.checkpoint = entry.leafUuid;
      this.cleared = false;
    } else if (entry.leafUuid === null && entry.explicit === true) {
      this.cleared = true;
      this.checkpoint = undefined;
      this.explicit = false;
      this.everExplicit = false;
    }
  }

  finish(): ClaudeTranscriptView {
    const rows = this.rows;
    if (this.unreadable.size > 0)
      for (const row of rows.values()) {
        const parent = row.parentUuid;
        if (parent !== null && !rows.has(parent) && this.unreadable.has(parent))
          row.parentUuid = this.skipUnreadable(parent);
      }
    const relinked = relinkCompaction(rows) !== undefined;
    const { leaf, start } = this.cleared ? {} : this.pickLeaf(relinked);
    const parents = new Map<string, string | null>();
    for (const row of rows.values()) parents.set(row.uuid, row.parentUuid);
    const chain = new Set<string>();
    for (let cursor = leaf; cursor !== undefined && !chain.has(cursor) && parents.has(cursor); ) {
      chain.add(cursor);
      cursor = parents.get(cursor) ?? undefined;
    }
    const checkpoint =
      this.checkpoint !== undefined && rows.has(this.checkpoint) ? this.checkpoint : undefined;
    return {
      parents,
      leaf,
      chain,
      start,
      pickedCheckpoint: start !== undefined && start === checkpoint,
      checkpoint,
    };
  }

  private skipUnreadable(uuid: string): string | null {
    const seen = new Set<string>();
    let cursor: string | null = uuid;
    while (cursor !== null && !this.rows.has(cursor) && this.unreadable.has(cursor)) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      cursor = this.unreadable.get(cursor) ?? null;
    }
    return cursor;
  }

  /** The newest row at or below `uuid`, used only when no checkpoint was ever written. */
  private newestDescendant(uuid: string): string {
    const reaches = new Map<string, boolean>([[uuid, true]]);
    const descends = (from: string) => {
      const path: string[] = [];
      let result = false;
      for (let cursor: string | undefined = from; cursor !== undefined; ) {
        const known = reaches.get(cursor);
        if (known !== undefined) {
          result = known;
          break;
        }
        reaches.set(cursor, false);
        path.push(cursor);
        cursor = this.rows.get(cursor)?.parentUuid ?? undefined;
      }
      for (const visited of path) reaches.set(visited, result);
      return result;
    };
    let newest = uuid;
    let newestTime = "";
    for (const row of this.rows.values())
      if (
        !row.isSidechain &&
        row.uuid !== uuid &&
        row.timestamp !== undefined &&
        row.timestamp >= newestTime &&
        descends(row.uuid)
      ) {
        newest = row.uuid;
        newestTime = row.timestamp;
      }
    return newest;
  }

  private pickLeaf(relinked: boolean): { leaf?: string; start?: string | undefined } {
    const rows = this.rows;
    const checkpoint =
      this.checkpoint !== undefined && rows.has(this.checkpoint) ? this.checkpoint : undefined;
    const pinned = this.explicit && checkpoint !== undefined && !rows.get(checkpoint)!.isSidechain;
    const throughBatch = !this.everExplicit;
    const lastRow = this.lastRow;
    if (!relinked || pinned) {
      let start = checkpoint;
      if (
        start !== undefined &&
        !this.explicit &&
        lastRow !== undefined &&
        rows.has(lastRow) &&
        lastRow !== start &&
        continuesFrom(rows, lastRow, start, true, throughBatch)
      )
        start = lastRow;
      if (!relinked)
        start ??=
          !this.sawCheckpoint && lastRow && this.newestRow && this.newestRow !== lastRow
            ? this.newestDescendant(lastRow)
            : lastRow;
      const leaf = start !== undefined ? nearestMessage(rows, start) : undefined;
      if (leaf) return { leaf, start };
    }
    const leaves = leafMessages(rows);
    if (leaves.size <= 1) {
      const [leaf] = leaves;
      return leaf ? { leaf, start: leaf } : {};
    }
    const start =
      checkpoint !== undefined &&
      leaves.has(checkpoint) &&
      (this.explicit ||
        lastRow === undefined ||
        !continuesFrom(rows, lastRow, checkpoint, false, throughBatch))
        ? checkpoint
        : lastRow;
    const leaf = start !== undefined ? nearestMessage(rows, start) : undefined;
    return leaf ? { leaf, start } : {};
  }
}

export function buildClaudeTranscriptView(
  records: Iterable<unknown>,
  lenient = false,
): ClaudeTranscriptView {
  const loader = new ClaudeTranscriptLoader(lenient);
  for (const record of records) loader.add(record);
  return loader.finish();
}
