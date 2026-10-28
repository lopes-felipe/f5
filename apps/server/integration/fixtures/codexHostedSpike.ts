/**
 * Pure helpers for the Codex-hosted `node_repl` spike (Spike D). The harness observes;
 * these only parse what it read and pick the runtime branches from its observations.
 */

/** OpenAI's signing team; ChatGPT's Chrome host only serves peers signed by it. */
export const OPENAI_TEAM_ID = "2DC432GLL2";
/** Codex release the spike starts from; older builds can't host `node_repl` for Chrome. */
export const CODEX_HOSTED_MIN_VERSION = "0.162.1";

/** Every observation Spike D must record; each is computed, never assumed. */
export const CODEX_HOSTED_OBSERVATIONS = [
  "codex-parent-accepted",
  "parent-identity",
  "approval-requested",
  "own-process-group",
  "inventory-via-status",
  "kill-stops-background",
  "reload-respawns",
  "turn-ended-callable",
] as const;
export type CodexHostedObservation = (typeof CODEX_HOSTED_OBSERVATIONS)[number];

export interface SpikeProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** The executable path `ps -o comm=` reports. */
  readonly command: string;
}

/** Parses `ps -A -o pid=,ppid=,pgid=,comm=`; unreadable rows are skipped. */
export function parseSpikeProcessRows(stdout: string): SpikeProcessRow[] {
  const rows: SpikeProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4]!,
    });
  }
  return rows;
}

/** `root`'s descendants, parents before children (excludes `root`). */
export function spikeDescendants(
  rows: ReadonlyArray<SpikeProcessRow>,
  root: number,
): SpikeProcessRow[] {
  const found: SpikeProcessRow[] = [];
  const queue = [root];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const row of rows)
      if (row.ppid === parent && !seen.has(row.pid)) {
        seen.add(row.pid);
        found.push(row);
        queue.push(row.pid);
      }
  }
  return found;
}

/** Processes below the spawned app-server running exactly the verified `node_repl`. */
export function nodeReplCandidates(
  rows: ReadonlyArray<SpikeProcessRow>,
  appServerPid: number,
  nodeReplPath: string,
): SpikeProcessRow[] {
  return spikeDescendants(rows, appServerPid).filter((row) => row.command === nodeReplPath);
}

/** Tree-kill order for `pid`: its descendants deepest first, then `pid` itself. */
export function treeKillOrder(rows: ReadonlyArray<SpikeProcessRow>, pid: number): number[] {
  return [
    ...spikeDescendants(rows, pid)
      .map((row) => row.pid)
      .reverse(),
    pid,
  ];
}

export { codexParentIdentifierAllowed } from "@t3tools/shared/providerIntegrationCertification";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A Codex tool-call approval for `serverName`, with the tool it names (from `_meta` or the
 * prompt text). Undefined for anything else, including other servers' requests.
 */
export function nodeReplToolApproval(
  method: string,
  params: unknown,
  serverName: string,
): { readonly tool: string | undefined; readonly code: string | undefined } | undefined {
  const request = record(params);
  const meta = record(request?._meta);
  if (
    method !== "mcpServer/elicitation/request" ||
    request?.serverName !== serverName ||
    typeof meta?.codex_approval_kind !== "string"
  )
    return undefined;
  const named =
    typeof meta.tool_name === "string"
      ? meta.tool_name
      : typeof request.message === "string"
        ? /run tool "([^"]+)"/.exec(request.message)?.[1]
        : undefined;
  const code = record(meta.tool_params)?.code;
  return { tool: named, code: typeof code === "string" ? code : undefined };
}

/** Tools from one `mcpServerStatus/list` row, with whichever schema key Codex used. */
export function statusTools(
  row: unknown,
): Array<{ name: string; description?: string; inputSchema: unknown }> {
  const tools = record(record(row)?.tools);
  if (!tools) return [];
  return Object.entries(tools).flatMap(([key, value]) => {
    const tool = record(value);
    if (!tool) return [];
    const name = typeof tool.name === "string" ? tool.name : key;
    const inputSchema = tool.inputSchema ?? tool.input_schema;
    return [
      {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        inputSchema,
      },
    ];
  });
}

export interface CodexHostedBranches {
  /** `blocked`: the host rejected a Codex-started `node_repl`; the gate stays closed. */
  readonly admission: "per-call" | "session" | "blocked";
  readonly kill: "group" | "tree";
  /** Without a respawn after reload there is no idle stop; a kill needs a new session. */
  readonly idleStop: boolean;
  readonly interruptDrain: "turn_ended" | "kill";
}

/** The Phase 1 branches the plan selects from Spike D's observations. */
export function codexHostedBranches(
  observed: Readonly<Record<CodexHostedObservation, boolean>>,
): CodexHostedBranches {
  return {
    admission: !observed["codex-parent-accepted"]
      ? "blocked"
      : observed["approval-requested"]
        ? "per-call"
        : "session",
    kill: observed["own-process-group"] ? "group" : "tree",
    idleStop: observed["reload-respawns"],
    interruptDrain: observed["turn-ended-callable"] ? "turn_ended" : "kill",
  };
}
