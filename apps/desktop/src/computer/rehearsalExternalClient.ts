import { randomUUID } from "node:crypto";
import {
  F5_PROTOCOL_VERSION,
  NextTurnQueueSubmitInput,
  ORCHESTRATION_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import { Schema } from "effect";

type Socket = Pick<WebSocket, "send" | "close" | "addEventListener">;
const READ_METHODS = new Set<string>([
  ORCHESTRATION_WS_METHODS.getSnapshot,
  ORCHESTRATION_WS_METHODS.getThreadTailDetails,
  WS_METHODS.computerAccessList,
]);
const COMMANDS = new Set(["thread.turn.interrupt", "thread.session.stop"]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class RehearsalTransportError extends Error {
  constructor(readonly outcome: "Interrupted" | "OutcomeUnknown" | "Unavailable") {
    super("External rehearsal transport " + outcome);
  }
}

/** Development rehearsal client for the existing authenticated orchestration API.
 * No execute, lease, grant answer, settings change or native message API. It never
 * retries dispatches and never exposes the authentication URL or provider errors. */
export class RehearsalExternalClient {
  private readonly pending = new Map<
    string,
    {
      mutation: boolean;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  private welcomed = false;
  private ready: (() => void) | undefined;
  private refused: ((error: Error) => void) | undefined;
  private readonly timeoutMs: number;
  private constructor(
    private readonly socket: Socket,
    private readonly onPush: (channel: string, data: unknown) => void,
    timeoutMs: number,
  ) {
    this.timeoutMs = timeoutMs;
    socket.addEventListener("message", (event: MessageEvent) => this.receive(event.data));
    socket.addEventListener("error", () => this.fail());
    socket.addEventListener("close", () => this.fail());
  }
  static async connect(
    authenticatedUrl: string,
    onPush: (channel: string, data: unknown) => void = () => {},
    options: { createSocket?: (url: string) => Socket; timeoutMs?: number } = {},
  ) {
    let url: URL;
    try {
      url = new URL(authenticatedUrl);
    } catch {
      throw new RehearsalTransportError("Unavailable");
    }
    if (
      url.protocol !== "ws:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" ||
      url.username ||
      url.password
    )
      throw new RehearsalTransportError("Unavailable");
    url.searchParams.set("protocol", String(F5_PROTOCOL_VERSION));
    const timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
      throw new RehearsalTransportError("Unavailable");
    let socket: Socket;
    try {
      socket = (options.createSocket ?? ((address) => new WebSocket(address)))(url.toString());
    } catch {
      throw new RehearsalTransportError("Unavailable");
    }
    const client = new RehearsalExternalClient(socket, onPush, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => client.fail(), timeoutMs);
      client.ready = () => {
        clearTimeout(timer);
        resolve();
      };
      client.refused = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    return client;
  }
  private fail() {
    if (this.closed) return;
    this.closed = true;
    this.refused?.(new RehearsalTransportError("Unavailable"));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new RehearsalTransportError(pending.mutation ? "OutcomeUnknown" : "Interrupted"),
      );
    }
    this.pending.clear();
    try {
      this.socket.close();
    } catch {
      /* All pending work already failed closed. */
    }
  }
  private receive(raw: unknown) {
    if (this.closed) return;
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 16 * 1024 * 1024) {
      this.fail();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.fail();
      return;
    }
    if (!record(message)) {
      this.fail();
      return;
    }
    if (typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RehearsalTransportError("Unavailable"));
      else pending.resolve(message.result);
    } else if (typeof message.channel === "string") {
      if (message.channel === "server.welcome") {
        if (this.welcomed) {
          this.fail();
          return;
        }
        this.welcomed = true;
        this.ready?.();
      }
      try {
        this.onPush(message.channel, message.data);
      } catch {
        this.fail();
      }
    } else this.fail();
  }
  rpc(method: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const queuedTurn = method === WS_METHODS.nextTurnQueueSubmit;
    const mutation = method === ORCHESTRATION_WS_METHODS.dispatchCommand || queuedTurn;
    if (!READ_METHODS.has(method) && !mutation)
      return Promise.reject(new RehearsalTransportError("Unavailable"));
    if (
      !queuedTurn &&
      mutation &&
      (!record(body.command) ||
        typeof body.command.type !== "string" ||
        !COMMANDS.has(body.command.type))
    )
      return Promise.reject(new RehearsalTransportError("Unavailable"));
    if (
      queuedTurn &&
      (!Schema.is(NextTurnQueueSubmitInput)(body) ||
        body.intent !== "auto" ||
        body.command.bootstrap !== undefined ||
        body.command.dispatchSource !== undefined)
    )
      return Promise.reject(new RehearsalTransportError("Unavailable"));
    if (this.closed || !this.welcomed || this.pending.size >= 16)
      return Promise.reject(new RehearsalTransportError("Unavailable"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RehearsalTransportError(mutation ? "OutcomeUnknown" : "Interrupted"));
        // A timed-out write cannot be followed by another prompt on this transport.
        if (mutation) this.fail();
      }, this.timeoutMs);
      this.pending.set(id, { mutation, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, body: { ...body, _tag: method } }));
      } catch {
        this.fail();
      }
    });
  }
  close() {
    this.fail();
  }
}
