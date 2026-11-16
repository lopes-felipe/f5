import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";

test.each([process.execPath, "bun"])(
  "%s stops the watchdog while the owning backend keeps its lifetime pipe open",
  async (executable) => {
    const entry = new URL("./maintenanceOwner.ts", import.meta.url).href;
    const child = spawn(
      executable,
      [
        "--input-type=module",
        "--eval",
        `const { watchMaintenanceOwner } = await import(${JSON.stringify(entry)}); const stop = await watchMaintenanceOwner(); await stop(); process.stdout.write("stopped");`,
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on("data", (chunk) => {
      error += String(chunk);
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [code] = await Promise.race([
        once(child, "close"),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Watchdog did not stop: ${error}`)), 5000);
        }),
      ]);
      expect(code, error).toBe(0);
      expect(output).toBe("stopped");
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
    }
  },
);

test.each([process.execPath, "bun"])(
  "%s observes owner death while maintenance blocks the main thread",
  async (executable) => {
    const entry = new URL("./maintenanceOwner.ts", import.meta.url).href;
    const child = spawn(
      executable,
      [
        "--input-type=module",
        "--eval",
        `const {watchMaintenanceOwner} = await import(${JSON.stringify(entry)}); await watchMaintenanceOwner(); process.stdout.write("ready", () => { const until = Date.now() + 10000; while (Date.now() < until) {} });`,
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    const closed = once(child, "close");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        once(child.stdout!, "data"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Watchdog did not start")), 5000);
        }),
      ]);
      clearTimeout(timer);
      child.stdio[3]!.destroy();
      const [code, signal] = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Maintenance survived owner death")), 5000);
        }),
      ]);
      if (process.platform === "win32")
        expect(code !== null ? code !== 0 : signal === "SIGKILL").toBe(true);
      else {
        expect(code).toBeNull();
        expect(signal).toBe("SIGKILL");
      }
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  },
);
