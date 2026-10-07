/** Credential-free native lifecycle smoke; model turns and UI rewind are separate live checks. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const binary = process.env.CODEX_BINARY_PATH ?? "codex";
const home = await mkdtemp(path.join(tmpdir(), "f5-codex-certify-"));
const child = spawn(binary, ["app-server"], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map<
  number,
  { resolve: (value: any) => void; reject: (error: Error) => void }
>();
let nextId = 0;
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});
child.on("error", (error) => {
  for (const waiter of pending.values()) waiter.reject(error);
});
child.on("exit", () => {
  for (const waiter of pending.values()) waiter.reject(new Error("Codex exited before response"));
});
child.stderr.resume();
async function request(method: string, params: unknown): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}
try {
  const init = await request("initialize", {
    clientInfo: { name: "f5-release-zero-certification", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
  const opened = await request("thread/start", {
    cwd: home,
    approvalPolicy: "never",
    sandbox: "read-only",
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  });
  const id = opened.thread.id;
  await request("thread/unsubscribe", { threadId: id });
  console.log(
    `Native startup passed (${init.userAgent}): initialize, start, unsubscribe; isolated CODEX_HOME.`,
  );
  console.log(
    "This empty thread has no rollout yet. Read, fork, resume, retained-boundary rewind and UI follow-up require an authenticated first model turn and remain unverified.",
  );
} finally {
  lines.close();
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await exited;
  }
  await rm(home, { recursive: true, force: true });
}
