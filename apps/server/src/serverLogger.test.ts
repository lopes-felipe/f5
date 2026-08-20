import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Cause, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRotatingServerFileLogger } from "./serverLogger.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("server logger", () => {
  it("bounds the active log and retained rotations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-server-log-"));
    tempRoots.push(dir);
    const logPath = path.join(dir, "server.log");
    const logger = makeRotatingServerFileLogger(logPath, {
      maxBytes: 512,
      maxFiles: 2,
      batchWindowMs: 5,
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fileLogger = yield* logger;
          yield* Effect.withFiber((fiber) =>
            Effect.sync(() => {
              for (let index = 0; index < 30; index += 1) {
                fileLogger.log({
                  message: [`entry-${index}-${"x".repeat(80)}`],
                  logLevel: "Info",
                  cause: Cause.empty,
                  fiber,
                  date: new Date(),
                });
              }
            }),
          );
          yield* Effect.sleep("20 millis");
        }),
      ),
    );

    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(512);
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(`${logPath}.2`)).toBe(true);
    expect(fs.existsSync(`${logPath}.3`)).toBe(false);
  });

  it("fails layer construction when the log directory cannot be created", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-server-log-invalid-"));
    tempRoots.push(dir);
    const parentFile = path.join(dir, "not-a-directory");
    fs.writeFileSync(parentFile, "occupied", "utf8");

    await expect(
      Effect.runPromise(
        Effect.scoped(makeRotatingServerFileLogger(path.join(parentFile, "server.log"))),
      ),
    ).rejects.toThrow("Failed to initialize rotating server log");
  });

  it("surfaces background write failures through stderr", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f5-server-log-write-failure-"));
    tempRoots.push(dir);
    const logger = makeRotatingServerFileLogger(path.join(dir, "server.log"), {
      batchWindowMs: 5,
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fileLogger = yield* logger;
            fs.rmSync(dir, { recursive: true, force: true });
            yield* Effect.withFiber((fiber) =>
              Effect.sync(() => {
                fileLogger.log({
                  message: ["cannot be written"],
                  logLevel: "Error",
                  cause: Cause.empty,
                  fiber,
                  date: new Date(),
                });
              }),
            );
            yield* Effect.sleep("20 millis");
          }),
        ),
      );
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write rotating server log"),
        expect.anything(),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
