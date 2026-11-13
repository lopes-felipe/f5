import {
  USAGE_THREAD_TURNS_LIMIT,
  type MessageId,
  type TurnId,
  type UsageThreadTurn,
  type UsageTurnFact,
} from "@t3tools/contracts";

import type { ChatMessage } from "../../types";

/** Below this share of input read from cache, a turn counts as a miss. */
export const CACHE_MISS_RATIO = 0.5;
/** Shorter gaps between turns are not worth mentioning next to a miss. */
export const CACHE_IDLE_FLOOR_MS = 5 * 60_000;

/**
 * - `warm`: at least half the input came from the cache.
 * - `miss`: less than half did, after the thread's first recorded turn.
 * - `cold-start`: the thread's first recorded turn, which always writes the cache.
 * - `unreported`: the provider sent no cache counts for the turn.
 */
export type TurnCacheState = "warm" | "miss" | "cold-start" | "unreported";

export interface TurnCacheSummary {
  readonly turnId: TurnId;
  readonly state: TurnCacheState;
  /** Share of input read from the cache, 0..1. Null when unreported. */
  readonly ratio: number | null;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** Input neither read from nor written to the cache. */
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  /** Tokens the turn had to send without a cache hit. Null when unreported. */
  readonly rewrittenTokens: number | null;
  /** Time between the previous turn's end and this turn's start, at least the floor. */
  readonly idleMs: number | null;
  readonly completedAt: string;
}

export interface ThreadCacheSummary {
  /** Oldest first, one per recorded turn. */
  readonly turns: ReadonlyArray<TurnCacheSummary>;
  /** Share of all reported input read from the cache. Null when nothing was reported. */
  readonly overallRatio: number | null;
  readonly last: TurnCacheSummary | null;
}

interface TurnCacheCounts {
  readonly ratio: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly uncachedInput: number;
  readonly denominator: number;
  readonly rewritten: number;
}

/**
 * Claude reports cache reads and writes outside `input_tokens`; Codex and the
 * other OpenAI-style providers report cached input as part of it. The server's
 * usage totals make the same split.
 */
function cacheCounts(turn: UsageThreadTurn): TurnCacheCounts | null {
  const { inputTokens, cacheReadTokens } = turn;
  if (inputTokens === null || cacheReadTokens === null) return null;
  if (turn.provider === "claudeAgent") {
    const cacheWrite = turn.cacheWriteTokens ?? 0;
    const denominator = inputTokens + cacheReadTokens + cacheWrite;
    if (denominator === 0) return null;
    return {
      ratio: cacheReadTokens / denominator,
      cacheRead: cacheReadTokens,
      cacheWrite,
      uncachedInput: inputTokens,
      denominator,
      rewritten: turn.cacheWriteTokens ?? inputTokens,
    };
  }
  if (inputTokens === 0) return null;
  const cacheRead = Math.min(cacheReadTokens, inputTokens);
  const uncachedInput = inputTokens - cacheRead;
  return {
    ratio: cacheRead / inputTokens,
    cacheRead,
    cacheWrite: turn.cacheWriteTokens ?? 0,
    uncachedInput,
    denominator: inputTokens,
    rewritten: uncachedInput,
  };
}

/**
 * When each turn started: the user message just before the turn's first
 * assistant message, else that assistant message. User messages rarely carry
 * a turn id, so this reads message order instead.
 */
export function turnStartTimes(messages: ReadonlyArray<ChatMessage>): Map<TurnId, string> {
  const starts = new Map<TurnId, string>();
  let lastUserCreatedAt: string | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      lastUserCreatedAt = message.createdAt;
      continue;
    }
    if (message.role !== "assistant" || !message.turnId || starts.has(message.turnId)) continue;
    starts.set(message.turnId, lastUserCreatedAt ?? message.createdAt);
    lastUserCreatedAt = null;
  }
  return starts;
}

export function summarizeThreadCache(
  turns: ReadonlyArray<UsageThreadTurn>,
  turnStarts: ReadonlyMap<TurnId, string>,
): ThreadCacheSummary {
  let readTotal = 0;
  let denominatorTotal = 0;
  const summaries = turns.map((turn, index): TurnCacheSummary => {
    const counts = cacheCounts(turn);
    const previous = index > 0 ? turns[index - 1]! : null;
    const startedAt = turnStarts.get(turn.turnId);
    const gap =
      previous && startedAt ? Date.parse(startedAt) - Date.parse(previous.completedAt) : Number.NaN;
    const idleMs = Number.isFinite(gap) && gap >= CACHE_IDLE_FLOOR_MS ? gap : null;
    if (!counts) {
      return {
        turnId: turn.turnId,
        state: "unreported",
        ratio: null,
        cacheReadTokens: turn.cacheReadTokens ?? 0,
        cacheWriteTokens: turn.cacheWriteTokens ?? 0,
        uncachedInputTokens: turn.inputTokens ?? 0,
        outputTokens: turn.outputTokens ?? 0,
        rewrittenTokens: null,
        idleMs,
        completedAt: turn.completedAt,
      };
    }
    readTotal += counts.cacheRead;
    denominatorTotal += counts.denominator;
    const state: TurnCacheState =
      counts.ratio >= CACHE_MISS_RATIO ? "warm" : index === 0 ? "cold-start" : "miss";
    return {
      turnId: turn.turnId,
      state,
      ratio: counts.ratio,
      cacheReadTokens: counts.cacheRead,
      cacheWriteTokens: counts.cacheWrite,
      uncachedInputTokens: counts.uncachedInput,
      outputTokens: turn.outputTokens ?? 0,
      rewrittenTokens: counts.rewritten,
      idleMs,
      completedAt: turn.completedAt,
    };
  });
  return {
    turns: summaries,
    overallRatio: denominatorTotal > 0 ? readTotal / denominatorTotal : null,
    last: summaries.at(-1) ?? null,
  };
}

/** The last assistant message of each turn: where the turn's footer sits. */
export function lastAssistantMessageIdByTurn(
  messages: ReadonlyArray<ChatMessage>,
): Map<TurnId, MessageId> {
  const byTurn = new Map<TurnId, MessageId>();
  for (const message of messages) {
    if (message.role === "assistant" && message.turnId) byTurn.set(message.turnId, message.id);
  }
  return byTurn;
}

/** Missed turns keyed by the assistant message whose footer shows the pill. */
export function cacheMissesByAssistantMessageId(
  summary: ThreadCacheSummary,
  messageIdByTurn: ReadonlyMap<TurnId, MessageId>,
): Map<MessageId, TurnCacheSummary> {
  const misses = new Map<MessageId, TurnCacheSummary>();
  for (const turn of summary.turns) {
    if (turn.state !== "miss") continue;
    const messageId = messageIdByTurn.get(turn.turnId);
    if (messageId) misses.set(messageId, turn);
  }
  return misses;
}

/**
 * Folds a just-recorded fact into a thread's turns the way the server stores
 * it: an older fact never replaces a newer one for the same turn, and only the
 * newest `USAGE_THREAD_TURNS_LIMIT` turns are kept.
 */
export function mergeThreadTurn(
  turns: ReadonlyArray<UsageThreadTurn>,
  fact: UsageTurnFact,
): ReadonlyArray<UsageThreadTurn> {
  const existing = turns.find((turn) => turn.turnId === fact.turnId);
  if (existing && existing.completedAt > fact.completedAt) return turns;
  const next: UsageThreadTurn = {
    turnId: fact.turnId,
    provider: fact.provider,
    model: fact.model,
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
    cacheReadTokens: fact.cacheReadTokens,
    cacheWriteTokens: fact.cacheWriteTokens,
    completedAt: fact.completedAt,
  };
  const merged = [...turns.filter((turn) => turn.turnId !== fact.turnId), next].toSorted(
    (left, right) =>
      left.completedAt.localeCompare(right.completedAt) || left.turnId.localeCompare(right.turnId),
  );
  return merged.length > USAGE_THREAD_TURNS_LIMIT
    ? merged.slice(merged.length - USAGE_THREAD_TURNS_LIMIT)
    : merged;
}

/**
 * A map as one string, so a memo keyed on it survives message objects that
 * streaming replaces without changing any entry. Ids and ISO timestamps never
 * contain tabs or newlines.
 */
export function encodeStringMap(map: ReadonlyMap<string, string>): string {
  let encoded = "";
  for (const [key, value] of map) encoded += `${key}\t${value}\n`;
  return encoded;
}

export function decodeStringMap<K extends string, V extends string>(encoded: string): Map<K, V> {
  const map = new Map<K, V>();
  for (const line of encoded.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    map.set(line.slice(0, tab) as K, line.slice(tab + 1) as V);
  }
  return map;
}

/** "12m", "3h", "2d": the rough gap shown beside a miss. */
export function formatIdle(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatCacheRatio(ratio: number): string {
  // A 99.6% hit must not read as 100% unless nothing missed.
  const percent = ratio >= 1 ? 100 : Math.min(99, Math.round(ratio * 100));
  return `${percent}%`;
}
