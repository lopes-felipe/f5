import { spawn } from "node:child_process";

export type Gh = (args: readonly string[], input?: string) => Promise<string>;

export const runGh: Gh = (args, input) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolvePromise(stdout)
        : reject(new Error(`gh ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.end(input ?? "");
  });
