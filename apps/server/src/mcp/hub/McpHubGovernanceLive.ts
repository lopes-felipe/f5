/**
 * SQLite-backed governance for F5's MCP hub (see `McpHubGovernance`). Pins and
 * conversation toggles are loaded once and kept in memory, so the hub's call path
 * never waits on the database; writes go through one ordered queue.
 *
 * Approvals are published as provider runtime events (`request.opened` /
 * `request.resolved`) for the conversation, so they show as the same approval card
 * Codex uses for MCP tool calls, and the user's answer comes back through
 * `ProviderService.respondToRequest`.
 */
import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  EventId,
  RuntimeRequestId,
  ThreadId,
  type McpAcceptToolChangesRequest,
  type McpListActivityRequest,
  type McpListActivityResult,
  type McpSetThreadServerEnabledRequest,
  type McpThreadServersResult,
  type McpToolCallApproval,
  type McpToolCallOutcome,
  type McpToolPin,
  type McpToolPinState,
  type ProviderApprovalOption,
  type ProviderKind,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { mcpServerNameKey } from "@t3tools/shared/mcpValidation";
import { Effect, Layer, Option, PubSub, ServiceMap, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CodexMcpEventBus } from "../../codex/CodexMcpEventBus.ts";
import {
  pinDigest,
  pinnedToolDefinition,
  type McpHubGovernance,
  type McpServerIdentity,
  type McpToolApprovalDecision,
  type McpToolApprovalInput,
  type McpToolCallLogEntry,
} from "./McpHubGovernance.ts";

export const MCP_ACTIVITY_RETENTION_DAYS = 30;
export const MCP_ACTIVITY_MAX_ROWS = 50_000;
/** Retention runs at startup and after this many recorded calls. */
const RETENTION_EVERY_CALLS = 500;
const DEFAULT_ACTIVITY_LIMIT = 50;
const HUB_REQUEST_PREFIX = "mcp-hub-";

interface PinRow {
  readonly identity: string;
  readonly serverKey: string;
  serverName: string;
  identityLabel: string;
  readonly toolName: string;
  acceptedDigest: string;
  acceptedJson: string;
  observedDigest: string;
  observedJson: string;
  isNew: boolean;
  readonly firstSeenAt: string;
  acceptedAt: string | null;
}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly finish: (decision: McpToolApprovalDecision) => void;
}

export interface McpHubGovernanceShape extends McpHubGovernance {
  /** F5's approval cards, as provider runtime events for the conversation. */
  readonly approvalEvents: Stream.Stream<ProviderRuntimeEvent>;
  /** Answers one of F5's approvals; false when the request is not the hub's. */
  readonly respondToApproval: (
    threadId: ThreadId,
    requestId: string,
    decision: McpToolApprovalDecision,
  ) => boolean;
  readonly isHubRequest: (requestId: string) => boolean;
  readonly listToolPins: (serverName: string) => ReadonlyArray<McpToolPin>;
  readonly acceptToolChanges: (input: McpAcceptToolChangesRequest) => Effect.Effect<number>;
  readonly listActivity: (input: McpListActivityRequest) => Effect.Effect<McpListActivityResult>;
  readonly threadServers: (threadId: ThreadId) => McpThreadServersResult;
  readonly setThreadServerEnabled: (
    input: McpSetThreadServerEnabledRequest,
  ) => Effect.Effect<McpThreadServersResult>;
}

export class McpHubGovernanceService extends ServiceMap.Service<
  McpHubGovernanceService,
  McpHubGovernanceShape
>()("t3/mcp/hub/McpHubGovernanceLive/McpHubGovernanceService") {}

function pinState(row: PinRow): McpToolPinState {
  if (row.observedDigest !== row.acceptedDigest) return "changed";
  return row.isNew ? "new" : "pinned";
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index]!);
}

function approvalDetail(input: McpToolApprovalInput): string {
  return input.reason === "changed"
    ? `The '${input.toolName}' tool on ${input.serverName} changed since it was last reviewed. Run it anyway? Review the change in MCP settings to stop this question.`
    : `Run the '${input.toolName}' tool on ${input.serverName}?`;
}

function approvalOptions(input: McpToolApprovalInput): ProviderApprovalOption[] {
  return [
    { decision: "accept", label: "Allow once" },
    ...(input.reason === "policy"
      ? [{ decision: "acceptForSession" as const, label: "Allow in this conversation" }]
      : []),
    { decision: "decline", label: "Deny" },
  ];
}

export const makeMcpHubGovernance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bus = Option.getOrUndefined(yield* Effect.serviceOption(CodexMcpEventBus));
  const services = yield* Effect.services<never>();
  const runPromise = Effect.runPromiseWith(services);
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  // ── State ──────────────────────────────────────────────────────────────
  const pins = new Map<string, Map<string, PinRow>>();
  const disabledServers = new Map<string, Map<string, string>>(); // thread → key → name
  const sessionAllowances = new Set<string>();
  const pending = new Map<string, PendingApproval>();
  const threadListeners = new Set<(threadId: ThreadId) => void>();
  let callsSinceRetention = 0;

  const pinRows = yield* sql<{
    identity: string;
    server_key: string;
    server_name: string;
    identity_label: string;
    tool_name: string;
    accepted_digest: string;
    accepted_json: string;
    observed_digest: string;
    observed_json: string;
    is_new: number;
    first_seen_at: string;
    accepted_at: string | null;
  }>`SELECT * FROM mcp_tool_pins`.pipe(Effect.orElseSucceed(() => []));
  for (const row of pinRows) {
    const byTool = pins.get(row.identity) ?? new Map<string, PinRow>();
    byTool.set(row.tool_name, {
      identity: row.identity,
      serverKey: row.server_key,
      serverName: row.server_name,
      identityLabel: row.identity_label,
      toolName: row.tool_name,
      acceptedDigest: row.accepted_digest,
      acceptedJson: row.accepted_json,
      observedDigest: row.observed_digest,
      observedJson: row.observed_json,
      isNew: row.is_new === 1,
      firstSeenAt: row.first_seen_at,
      acceptedAt: row.accepted_at,
    });
    pins.set(row.identity, byTool);
  }
  const overrideRows = yield* sql<{
    thread_id: string;
    server_key: string;
    server_name: string;
  }>`SELECT thread_id, server_key, server_name FROM mcp_thread_server_overrides`.pipe(
    Effect.orElseSucceed(() => []),
  );
  for (const row of overrideRows) {
    const servers = disabledServers.get(row.thread_id) ?? new Map<string, string>();
    servers.set(row.server_key, row.server_name);
    disabledServers.set(row.thread_id, servers);
  }

  // ── Writes ─────────────────────────────────────────────────────────────
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <A, E>(effect: Effect.Effect<A, E>): void => {
    queue = queue.then(() =>
      runPromise(
        effect.pipe(
          Effect.catchCause((cause) => Effect.logWarning("MCP hub governance write failed", cause)),
        ),
      ),
    );
  };

  const savePin = (row: PinRow) =>
    sql`INSERT INTO mcp_tool_pins (identity, server_key, server_name, identity_label, tool_name, accepted_digest, accepted_json, observed_digest, observed_json, is_new, first_seen_at, accepted_at)
      VALUES (${row.identity}, ${row.serverKey}, ${row.serverName}, ${row.identityLabel}, ${row.toolName}, ${row.acceptedDigest}, ${row.acceptedJson}, ${row.observedDigest}, ${row.observedJson}, ${row.isNew ? 1 : 0}, ${row.firstSeenAt}, ${row.acceptedAt})
      ON CONFLICT(identity, tool_name) DO UPDATE SET server_name=excluded.server_name, identity_label=excluded.identity_label, accepted_digest=excluded.accepted_digest, accepted_json=excluded.accepted_json, observed_digest=excluded.observed_digest, observed_json=excluded.observed_json, is_new=excluded.is_new, accepted_at=excluded.accepted_at`;

  const pruneCalls = Effect.gen(function* () {
    const cutoff = new Date(Date.now() - MCP_ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
    yield* sql`DELETE FROM mcp_tool_calls WHERE created_at < ${cutoff}`;
    yield* sql`DELETE FROM mcp_tool_calls WHERE id IN (SELECT id FROM mcp_tool_calls ORDER BY created_at DESC LIMIT -1 OFFSET ${MCP_ACTIVITY_MAX_ROWS})`;
  });
  enqueue(pruneCalls);

  const publishHubChange = (serverName: string) => {
    if (bus)
      void runPromise(
        bus.publishStatusUpdated({ scope: "common", reason: "hub", serverName }),
      ).catch(() => undefined);
  };

  // ── Pins ───────────────────────────────────────────────────────────────
  const observeTools = (
    serverName: string,
    identity: McpServerIdentity,
    tools: ReadonlyArray<Tool>,
  ) => {
    const existing = pins.get(identity.key) ?? new Map<string, PinRow>();
    const firstListing = existing.size === 0;
    const now = new Date().toISOString();
    let changed = false;
    for (const tool of tools) {
      if (!tool.name) continue;
      const definition = pinnedToolDefinition(tool);
      const digest = pinDigest(definition);
      const row = existing.get(tool.name);
      if (!row) {
        const created: PinRow = {
          identity: identity.key,
          serverKey: mcpServerNameKey(serverName),
          serverName,
          identityLabel: identity.label,
          toolName: tool.name,
          acceptedDigest: digest,
          acceptedJson: definition,
          observedDigest: digest,
          observedJson: definition,
          isNew: !firstListing,
          firstSeenAt: now,
          acceptedAt: firstListing ? now : null,
        };
        existing.set(tool.name, created);
        enqueue(savePin(created));
        changed ||= !firstListing;
      } else if (row.observedDigest !== digest) {
        row.observedDigest = digest;
        row.observedJson = definition;
        row.serverName = serverName;
        row.identityLabel = identity.label;
        enqueue(savePin(row));
        changed = true;
      }
    }
    pins.set(identity.key, existing);
    if (changed) publishHubChange(serverName);
  };

  const listToolPins = (serverName: string): McpToolPin[] => {
    const key = mcpServerNameKey(serverName);
    const result: McpToolPin[] = [];
    for (const byTool of pins.values())
      for (const row of byTool.values()) {
        if (row.serverKey !== key) continue;
        const state = pinState(row);
        result.push({
          serverName: row.serverName,
          identity: row.identity,
          identityLabel: row.identityLabel,
          toolName: row.toolName,
          state,
          firstSeenAt: row.firstSeenAt,
          ...(row.acceptedAt ? { acceptedAt: row.acceptedAt } : {}),
          accepted: row.acceptedJson,
          ...(state === "changed" ? { observed: row.observedJson } : {}),
        });
      }
    return result.toSorted(
      (left, right) =>
        left.identity.localeCompare(right.identity) || left.toolName.localeCompare(right.toolName),
    );
  };

  const acceptToolChanges = (input: McpAcceptToolChangesRequest) =>
    Effect.sync(() => {
      const byTool = pins.get(input.identity);
      if (!byTool) return 0;
      const names = input.toolNames ? new Set(input.toolNames) : undefined;
      const now = new Date().toISOString();
      let accepted = 0;
      for (const row of byTool.values()) {
        if (row.serverKey !== mcpServerNameKey(input.serverName)) continue;
        if (names && !names.has(row.toolName)) continue;
        if (pinState(row) === "pinned") continue;
        row.acceptedDigest = row.observedDigest;
        row.acceptedJson = row.observedJson;
        row.isNew = false;
        row.acceptedAt = now;
        enqueue(savePin(row));
        accepted += 1;
      }
      if (accepted > 0) publishHubChange(input.serverName);
      return accepted;
    });

  // ── Approvals ──────────────────────────────────────────────────────────
  const publishEvent = (event: ProviderRuntimeEvent) => {
    void runPromise(PubSub.publish(events, event)).catch(() => undefined);
  };

  const requestApproval = (input: McpToolApprovalInput): Promise<McpToolApprovalDecision> => {
    if (input.signal.aborted) return Promise.resolve("cancel");
    const requestId = `${HUB_REQUEST_PREFIX}${randomUUID()}`;
    const base = {
      provider: input.provider,
      threadId: input.threadId,
      requestId: RuntimeRequestId.makeUnsafe(requestId),
    };
    return new Promise((resolve) => {
      let done = false;
      const finish = (decision: McpToolApprovalDecision) => {
        if (done) return;
        done = true;
        pending.delete(requestId);
        input.signal.removeEventListener("abort", onAbort);
        publishEvent({
          ...base,
          eventId: EventId.makeUnsafe(randomUUID()),
          createdAt: new Date().toISOString(),
          type: "request.resolved",
          payload: { requestType: "mcp_elicitation_approval", decision },
        } as ProviderRuntimeEvent);
        resolve(decision);
      };
      const onAbort = () => finish("cancel");
      pending.set(requestId, { threadId: input.threadId, finish });
      input.signal.addEventListener("abort", onAbort, { once: true });
      publishEvent({
        ...base,
        eventId: EventId.makeUnsafe(randomUUID()),
        createdAt: new Date().toISOString(),
        type: "request.opened",
        payload: {
          requestType: "mcp_elicitation_approval",
          appName: input.serverName,
          detail: approvalDetail(input),
          approvalOptions: approvalOptions(input),
        },
      } as ProviderRuntimeEvent);
    });
  };

  const respondToApproval = (
    threadId: ThreadId,
    requestId: string,
    decision: McpToolApprovalDecision,
  ): boolean => {
    const approval = pending.get(requestId);
    if (!approval || approval.threadId !== threadId) return false;
    approval.finish(decision);
    return true;
  };

  const allowanceKey = (threadId: ThreadId, serverName: string, toolName: string) =>
    `${threadId}\0${mcpServerNameKey(serverName)}\0${toolName}`;

  // ── Conversation toggles ───────────────────────────────────────────────
  const threadServers = (threadId: ThreadId): McpThreadServersResult => ({
    disabledServers: [...(disabledServers.get(threadId)?.values() ?? [])].toSorted(),
  });

  const setThreadServerEnabled = (input: McpSetThreadServerEnabledRequest) =>
    Effect.gen(function* () {
      const key = mcpServerNameKey(input.serverName);
      const servers = disabledServers.get(input.threadId) ?? new Map<string, string>();
      const wasDisabled = servers.has(key);
      if (input.enabled === wasDisabled) {
        if (input.enabled) {
          servers.delete(key);
          yield* sql`DELETE FROM mcp_thread_server_overrides WHERE thread_id=${input.threadId} AND server_key=${key}`;
        } else {
          servers.set(key, input.serverName);
          yield* sql`INSERT INTO mcp_thread_server_overrides (thread_id, server_key, server_name, updated_at)
            VALUES (${input.threadId}, ${key}, ${input.serverName}, ${new Date().toISOString()})
            ON CONFLICT(thread_id, server_key) DO UPDATE SET server_name=excluded.server_name, updated_at=excluded.updated_at`;
        }
        if (servers.size > 0) disabledServers.set(input.threadId, servers);
        else disabledServers.delete(input.threadId);
        for (const listener of threadListeners) listener(input.threadId);
        publishHubChange(input.serverName);
      }
      return threadServers(input.threadId);
    }).pipe(Effect.orDie);

  // ── Call log ───────────────────────────────────────────────────────────
  const recordCall = (entry: McpToolCallLogEntry) => {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    enqueue(
      sql`INSERT INTO mcp_tool_calls (id, created_at, thread_id, project_id, provider, server_key, server_name, tool_name, outcome, duration_ms, approval, error_summary)
        VALUES (${id}, ${createdAt}, ${entry.threadId}, ${entry.projectId ?? null}, ${entry.provider}, ${mcpServerNameKey(entry.serverName)}, ${entry.serverName}, ${entry.toolName}, ${entry.outcome}, ${entry.durationMs}, ${entry.approval}, ${entry.errorSummary ?? null})`,
    );
    callsSinceRetention += 1;
    if (callsSinceRetention >= RETENTION_EVERY_CALLS) {
      callsSinceRetention = 0;
      enqueue(pruneCalls);
    }
  };

  const listActivity = (input: McpListActivityRequest) =>
    Effect.gen(function* () {
      // Reads see every call recorded before them.
      yield* Effect.promise(() => queue);
      const serverKey = input.serverName ? mcpServerNameKey(input.serverName) : null;
      const threadId = input.threadId ?? null;
      const limit = input.limit ?? DEFAULT_ACTIVITY_LIMIT;
      const rows = yield* sql<{
        id: string;
        created_at: string;
        thread_id: string;
        provider: string;
        server_name: string;
        tool_name: string;
        outcome: string;
        duration_ms: number;
        approval: string;
        error_summary: string | null;
      }>`SELECT id, created_at, thread_id, provider, server_name, tool_name, outcome, duration_ms, approval, error_summary
        FROM mcp_tool_calls
        WHERE (${serverKey} IS NULL OR server_key = ${serverKey})
          AND (${threadId} IS NULL OR thread_id = ${threadId})
        ORDER BY created_at DESC LIMIT ${limit}`;
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const recent = yield* sql<{
        outcome: string;
        duration_ms: number;
      }>`SELECT outcome, duration_ms FROM mcp_tool_calls
        WHERE created_at >= ${since}
          AND (${serverKey} IS NULL OR server_key = ${serverKey})
          AND (${threadId} IS NULL OR thread_id = ${threadId})`;
      // Latency covers calls that ran; refused and declined ones never reached the server.
      const ran = recent.filter((row) => row.outcome === "ok" || row.outcome === "error");
      const durations = ran.map((row) => row.duration_ms).toSorted((left, right) => left - right);
      const p50 = percentile(durations, 0.5);
      const p95 = percentile(durations, 0.95);
      return {
        calls: rows.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          threadId: ThreadId.makeUnsafe(row.thread_id),
          provider: row.provider as ProviderKind,
          serverName: row.server_name,
          toolName: row.tool_name,
          outcome: row.outcome as McpToolCallOutcome,
          durationMs: Math.max(0, Math.round(row.duration_ms)),
          approval: row.approval as McpToolCallApproval,
          ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
        })),
        last24h: {
          calls: ran.length,
          errors: ran.filter((row) => row.outcome === "error").length,
          ...(p50 !== undefined ? { p50Ms: p50 } : {}),
          ...(p95 !== undefined ? { p95Ms: p95 } : {}),
        },
      } satisfies McpListActivityResult;
    }).pipe(Effect.orDie);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const approval of [...pending.values()]) approval.finish("cancel");
    }).pipe(Effect.andThen(Effect.promise(() => queue))),
  );

  return {
    observeTools,
    pinState: (_serverName, identity, toolName) => {
      const row = pins.get(identity.key)?.get(toolName);
      return row ? pinState(row) : undefined;
    },
    requestApproval,
    allowedForSession: (threadId, serverName, toolName) =>
      sessionAllowances.has(allowanceKey(threadId, serverName, toolName)),
    allowForSession: (threadId, serverName, toolName) => {
      sessionAllowances.add(allowanceKey(threadId, serverName, toolName));
    },
    isServerDisabled: (threadId, serverName) =>
      disabledServers.get(threadId)?.has(mcpServerNameKey(serverName)) ?? false,
    onThreadServersChanged: (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    recordCall,
    get approvalEvents() {
      return Stream.fromPubSub(events);
    },
    respondToApproval,
    isHubRequest: (requestId) => requestId.startsWith(HUB_REQUEST_PREFIX),
    listToolPins,
    acceptToolChanges,
    listActivity,
    threadServers,
    setThreadServerEnabled,
  } satisfies McpHubGovernanceShape;
});

export const McpHubGovernanceLive = Layer.effect(McpHubGovernanceService, makeMcpHubGovernance);
