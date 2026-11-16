import {
  type AgentTranscriptItem,
  type AgentsReadTranscriptInput,
  isToolLifecycleItemType,
} from "@t3tools/contracts";
import { Effect } from "effect";
import {
  normalizeCodexThreadItemType,
  itemTitle,
  itemDetail,
  itemLifecycleStatus,
} from "../codexItemPresentation.ts";
import { transcriptRecord } from "../claudeTranscript.ts";
import { boundedText } from "./normalizeClaudeSubagentRecord.ts";
import { decodeCursor, encodeCursor } from "./agentTranscriptCursor.ts";
import { emptyTranscriptPage, unavailable } from "./readClaudeAgentTranscript.ts";
import { fitTranscriptItems, TRANSCRIPT_PAGE_BYTES } from "./transcriptPageBudget.ts";

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((entry) => (typeof entry === "string" ? entry : (transcriptRecord(entry)?.text ?? "")))
      .join("\n");
  return "";
}
export function normalizeCodexThreadItem(
  value: unknown,
  fallbackId: string,
): AgentTranscriptItem[] {
  const envelope = transcriptRecord(value);
  const item = transcriptRecord(envelope?.item) ?? envelope;
  if (!item) return [];
  const type = normalizeCodexThreadItemType(item.type ?? item.kind);
  if (type === "hook_prompt") return [];
  const id = typeof item.id === "string" && item.id.length <= 512 ? item.id : fallbackId;
  const base = { id, createdAt: null };
  if (type === "user_message" || type === "assistant_message")
    return [
      {
        ...base,
        kind: "message",
        role: type === "user_message" ? "user" : "assistant",
        ...boundedText(item.text ?? textContent(item.content), 32768),
      },
    ];
  if (type === "reasoning")
    return [
      {
        ...base,
        kind: "reasoning",
        ...boundedText(
          [textContent(item.summary), textContent(item.content)].filter(Boolean).join("\n"),
          16384,
        ),
      },
    ];
  if (isToolLifecycleItemType(type)) {
    const output = boundedText(item.aggregatedOutput ?? item.result ?? item.error, 8192);
    // Persisted items without a lifecycle status are complete snapshots.
    const lifecycleStatus = itemLifecycleStatus(item, "item.completed");
    const failed =
      item.error != null || lifecycleStatus === "failed" || lifecycleStatus === "declined";
    return [
      {
        ...base,
        kind: "tool-call",
        toolCallId: id,
        toolName: boundedText(item.tool ?? type, 128).text,
        itemType: type,
        title: itemTitle(type) ?? boundedText(item.title ?? type.replaceAll("_", " "), 256).text,
        detail: boundedText(itemDetail(type, item, {}) ?? item.arguments ?? "", 1024).text,
        status: failed ? "failed" : lifecycleStatus === "inProgress" ? "running" : "completed",
        output: output.text + (item.exitCode != null ? "\nExit code: " + item.exitCode : ""),
        outputTruncated: output.truncated,
      },
    ];
  }
  return [
    {
      ...base,
      kind: "notice",
      text:
        type === "context_compaction"
          ? "Conversation compacted"
          : "Unsupported item: " + boundedText(item.type, 128).text,
    },
  ];
}
export function readCodexAgentTranscript<E>(
  input: AgentsReadTranscriptInput,
  read: (
    cursor: string | null,
  ) => Effect.Effect<
    | { kind: "page"; data: unknown[]; nextCursor: string | null }
    | { kind: "session-not-running" | "unsupported-provider" },
    E
  >,
) {
  return Effect.gen(function* () {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (cursor && cursor.p !== "codex") throw new Error("Wrong provider cursor.");
    // Old cursors have no native item ordinal; reopen rather than invent order.
    if (cursor && (cursor.i === undefined || cursor.fi === undefined))
      return { ...emptyTranscriptPage(), reset: true };
    let current = cursor?.c ?? cursor?.floor ?? null;
    if (current === "") current = null;
    let floor = cursor?.floor ?? null,
      floorSet = cursor?.floor != null && current !== (cursor.floor === "" ? null : cursor.floor),
      lastStart = current,
      next: string | null = null,
      bytes = 0;
    let ordinal = cursor?.i ?? 0,
      floorOrdinal = cursor?.fi ?? 0,
      lastStartOrdinal = ordinal;
    const items: AgentTranscriptItem[] = [];
    for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
      lastStart = current;
      lastStartOrdinal = ordinal;
      const page = yield* read(current);
      if (page.kind !== "page") return unavailable(page.kind);
      let normalizedPage: AgentTranscriptItem[] = page.data.flatMap((raw, index) =>
        normalizeCodexThreadItem(raw, "omitted:" + (current ?? "start") + ":" + index).map(
          (item) => ({
            ...item,
            position: { offset: ordinal + index, index: 0 },
          }),
        ),
      );
      let pageBytes = Buffer.byteLength(JSON.stringify(normalizedPage));
      if (
        items.length &&
        (bytes + pageBytes > TRANSCRIPT_PAGE_BYTES - 16 * 1024 ||
          items.length + normalizedPage.length > (input.limit ?? 200))
      ) {
        next = current;
        break;
      }
      normalizedPage = fitTranscriptItems(normalizedPage);
      pageBytes = Buffer.byteLength(JSON.stringify(normalizedPage));
      for (const item of normalizedPage) {
        if (!floorSet && item.kind === "tool-call" && item.status === "running") {
          floor = current ?? "";
          floorOrdinal = ordinal;
          floorSet = true;
        }
        items.push(item);
      }
      bytes += pageBytes;
      next = page.nextCursor;
      ordinal += page.data.length;
      if (!next || items.length >= (input.limit ?? 200) || bytes >= 900 * 1024) break;
      current = next;
    }
    const at = (c: string | null, i: number) =>
      encodeCursor({
        v: 1,
        p: "codex",
        c,
        floor: floorSet ? floor : null,
        i,
        fi: floorSet ? floorOrdinal : 0,
      });
    return {
      ...emptyTranscriptPage(),
      items,
      nextCursor: next ? at(next, ordinal) : null,
      tailCursor: at(floorSet ? floor : lastStart, floorSet ? floorOrdinal : lastStartOrdinal),
    };
  });
}
