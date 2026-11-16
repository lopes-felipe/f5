import { spawn } from "node:child_process";

/** A usable helper must answer both requests. Elevated Windows CI may only prove
 * a clean, fail-closed missing-permissions startup; it never proves input health. */
export function checkComputerHelperProtocol(binary: string, args: string[] = []): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let hello = false;
    let permissions = false;
    let suspended = false;
    let blockedStartup = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      if (error) reject(error);
      else accept();
    };
    const timer = setTimeout(() => finish(new Error("Helper protocol check timed out.")), 10_000);
    child.on("error", finish);
    // Early, intentional startup refusal can close stdin between hello and the
    // probe writes. Decide from the complete output and exit status, not EPIPE.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") finish(error);
    });
    child.stderr.resume();
    child.on("close", (code, signal) => {
      if (hello && blockedStartup && code === 0 && signal === null) finish();
      else finish(new Error(`Helper exited before completing its protocol check (code ${code}).`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        if (end > 12 * 1024 * 1024) {
          finish(new Error("Helper protocol line exceeds its size limit."));
          return;
        }
        let message: {
          type?: string;
          protocolVersion?: number;
          requestId?: string;
          error?: unknown;
          result?: { available?: boolean };
          status?: { available?: boolean; reason?: string };
        };
        try {
          const parsed: unknown = JSON.parse(buffer.slice(0, end));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid message");
          message = parsed;
        } catch {
          finish(new Error("Invalid helper protocol JSON."));
          return;
        }
        buffer = buffer.slice(end + 1);
        if (message.type === "hello") {
          if (hello || message.protocolVersion !== 1) {
            finish(new Error("Helper protocol mismatch."));
            return;
          }
          hello = true;
          child.stdin.write(
            '{"type":"request","request":{"op":"status","requestId":"protocol-permissions"}}\n',
          );
          child.stdin.write('{"type":"suspend","requestId":"protocol-check"}\n');
        }
        if (hello && message.type === "status" && message.status?.available === false)
          blockedStartup = message.status.reason === "missing-permissions";
        if (hello && message.type === "response" && !message.error) {
          if (message.requestId === "protocol-permissions")
            permissions = typeof message.result?.available === "boolean";
          if (message.requestId === "protocol-check") suspended = true;
        }
        if (permissions && suspended) {
          finish();
          return;
        }
      }
      if (buffer.length > 12 * 1024 * 1024)
        finish(new Error("Helper protocol line exceeds its size limit."));
    });
  });
}
