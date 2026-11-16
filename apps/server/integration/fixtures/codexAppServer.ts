import { type ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

import { parseSpikeProcessRows, treeKillOrder } from "./codexHostedSpike";

/** Shared by the live Codex Chrome harnesses: `codex app-server` over stdio and `ps`. */

export const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined || Date.now() >= deadline) return value;
    await delay(100);
  }
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function processRows() {
  return parseSpikeProcessRows(
    execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" }),
  );
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM deepest first, SIGKILL after 1 s, as main's emergency stop does. */
export async function killTree(pid: number): Promise<number[]> {
  const order = treeKillOrder(processRows(), pid);
  for (const target of order) if (alive(target)) process.kill(target, "SIGTERM");
  await delay(1000);
  for (const target of order) if (alive(target)) process.kill(target, "SIGKILL");
  return order;
}

/** Newline-delimited JSON-RPC with `codex app-server`, answering its requests. */
export class AppServer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  readonly notifications: Array<{ method: string; params: unknown; at: number }> = [];
  /** Called with every notification as it arrives. */
  readonly listeners = new Set<(method: string, params: unknown) => void>();
  /** Every request Codex sent (method and server only). */
  readonly serverRequests: Array<{ method: string; serverName?: unknown; at: number }> = [];
  stderrTail = "";

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly answer: (method: string, params: unknown) => unknown,
  ) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-16_384);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    child.once("exit", () => {
      for (const pending of this.pending.values())
        pending.reject(new Error("codex app-server exited."));
      this.pending.clear();
    });
  }

  private receive(line: string) {
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    const id = message.id;
    if (typeof message.method === "string" && (typeof id === "number" || typeof id === "string")) {
      this.serverRequests.push({
        method: message.method,
        serverName: asRecord(message.params)?.serverName,
        at: Date.now(),
      });
      let result: unknown;
      try {
        result = this.answer(message.method, message.params);
      } catch (error) {
        this.write({ id, error: { code: -32601, message: errorText(error) } });
        return;
      }
      this.write({ id, result });
      return;
    }
    if (typeof message.method === "string") {
      this.notifications.push({ method: message.method, params: message.params, at: Date.now() });
      for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = asRecord(message.error);
    if (error) pending.reject(new Error(String(error.message ?? "JSON-RPC error")));
    else pending.resolve(message.result);
  }

  private write(message: unknown) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.write({ id, method, params });
    });
  }

  /** The latest startup status Codex reported for `name` after `since`. */
  startupStatus(name: string, since: number): string | undefined {
    const last = this.notifications.findLast(
      (entry) =>
        entry.at >= since &&
        entry.method === "mcpServer/startupStatus/updated" &&
        asRecord(entry.params)?.name === name,
    );
    const status = asRecord(last?.params)?.status;
    return typeof status === "string" ? status : undefined;
  }

  /** The `turn/completed` notification for `turnId`, once it arrives. */
  turnCompleted(turnId: string, since: number) {
    return this.notifications.find(
      (entry) =>
        entry.at >= since &&
        entry.method === "turn/completed" &&
        asRecord(asRecord(entry.params)?.turn)?.id === turnId,
    );
  }

  /** `node_repl` tool-call items Codex completed after `since`. */
  toolCalls(server: string, since: number) {
    return this.notifications
      .filter((entry) => entry.at >= since && entry.method === "item/completed")
      .map((entry) => asRecord(asRecord(entry.params)?.item))
      .filter((item) => item?.type === "mcpToolCall" && item.server === server);
  }
}
