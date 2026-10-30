import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { chaosTimeout } from "./timeouts.ts";

export function spawnJsonFixture(input: {
  script: string;
  args: string[];
  prefix?: string;
  gracefulQuit?: boolean;
}) {
  const child = spawn("bun", [input.script, ...input.args], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  const lines = createInterface({ input: child.stdout });
  const messages: Array<Record<string, unknown>> = [];
  let receivedMessage = false;
  let failure: Error | undefined;
  const waiters = new Set<{
    type: string;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  const fail = (error: Error) => {
    failure = error;
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  };
  lines.on("line", (line) => {
    if (input.prefix && !line.startsWith(input.prefix)) return;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(input.prefix ? line.slice(input.prefix.length) : line);
    } catch (error) {
      fail(new Error(`Invalid fixture response: ${String(error)}`));
      return;
    }
    receivedMessage = true;
    if (value.type === "failure") {
      fail(new Error(String(value.message)));
      return;
    }
    const waiter = [...waiters].find((waiter) => waiter.type === value.type);
    if (waiter) {
      waiters.delete(waiter);
      waiter.resolve(value);
    } else if (messages.length < 256) messages.push(value);
    else fail(new Error("Fixture response backlog exceeded 256 messages"));
  });
  child.on("error", fail);
  const exited = once(child, "exit");
  void exited.catch(() => {});
  child.once("exit", () => fail(new Error(`Fixture exited: ${stderr}`)));
  const next = async (type: string): Promise<Record<string, unknown>> => {
    const index = messages.findIndex((message) => message.type === type);
    if (index >= 0) return messages.splice(index, 1)[0]!;
    if (failure) throw failure;
    const phase = receivedMessage ? "response" : "startup";
    const timeout = receivedMessage ? 15_000 : chaosTimeout(15_000);
    const label = `${phase}, ${timeout}ms; ${input.script}; pid ${child.pid ?? "unknown"}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: {
      type: string;
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    };
    try {
      return await new Promise((resolve, reject) => {
        waiter = { type, resolve, reject };
        waiters.add(waiter);
        timer = setTimeout(
          () => reject(new Error(`Waiting for fixture ${type} (${label}): ${stderr}`)),
          timeout,
        );
      });
    } finally {
      if (timer) clearTimeout(timer);
      waiters.delete(waiter!);
    }
  };
  const send = (method: string, parameters: Record<string, unknown> = {}) =>
    child.stdin.write(`${JSON.stringify({ method, ...parameters })}\n`);
  const finish = async (force: boolean) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_800);
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (force) child.kill("SIGKILL");
        else if (input.gracefulQuit) send("quit");
        else child.kill("SIGTERM");
      }
      await exited;
    } finally {
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      child.stderr.destroy();
    }
  };
  return { next, send, close: () => finish(false), kill: () => finish(true) };
}
