import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

export class FakeClaudeCodeProcess implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;

  private readonly events = new EventEmitter();
  private bufferedInput = "";

  constructor(
    private readonly onMessage: (
      message: Record<string, unknown>,
      process: FakeClaudeCodeProcess,
    ) => void,
  ) {
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      this.bufferedInput += chunk;
      this.drainInput();
    });
  }

  emitJson(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(_signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.stdout.end();
    this.events.emit("exit", 0, null);
    return true;
  }

  on(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.on(event, listener);
  }

  once(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.once(event, listener);
  }

  off(
    event: "exit" | "error",
    listener:
      | ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.off(event, listener);
  }

  private drainInput(): void {
    while (true) {
      const newlineIndex = this.bufferedInput.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = this.bufferedInput.slice(0, newlineIndex).trim();
      this.bufferedInput = this.bufferedInput.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      this.onMessage(JSON.parse(line) as Record<string, unknown>, this);
    }
  }
}

export function respondToInitializeRequest(
  message: Record<string, unknown>,
  process: FakeClaudeCodeProcess,
  responseOverrides?: Record<string, unknown>,
): boolean {
  if (
    message.type !== "control_request" ||
    typeof message.request_id !== "string" ||
    !message.request ||
    typeof message.request !== "object" ||
    (message.request as { subtype?: unknown }).subtype !== "initialize"
  ) {
    return false;
  }

  process.emitJson({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: message.request_id,
      response: {
        commands: [],
        agents: [],
        output_style: "default",
        available_output_styles: ["default"],
        models: [],
        account: {
          subscriptionType: "max",
        },
        ...responseOverrides,
      },
    },
  });

  return true;
}

export function createControllableAsyncIterable<T>() {
  const queue: Array<T> = [];
  const waiters: Array<{
    readonly resolve: (value: IteratorResult<T>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  let done = false;
  let failure: unknown | undefined;

  const wakeDone = () => {
    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: () => {
            if (queue.length > 0) {
              const value = queue.shift();
              if (value !== undefined) {
                return Promise.resolve({ done: false, value });
              }
            }
            if (failure !== undefined) {
              const cause = failure;
              failure = undefined;
              return Promise.reject(cause);
            }
            if (done) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return new Promise((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return: async () => ({ done: true, value: undefined }),
        };
      },
    } satisfies AsyncIterable<T>,
    push(value: T): void {
      if (done) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve({ done: false, value });
        return;
      }
      queue.push(value);
    },
    end(): void {
      if (done) {
        return;
      }
      done = true;
      wakeDone();
    },
    fail(cause: unknown): void {
      if (done) {
        return;
      }
      done = true;
      failure = cause;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(cause);
      }
    },
  };
}
