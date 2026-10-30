import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

type RunResult = { status: number | null; stdout: string };
type Run = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    killSignal?: NodeJS.Signals;
  },
) => RunResult;
const require = createRequire(import.meta.url);
const { notarizeAndStaple, verifyClaudeRuntime } = require("./notarize-mac.cjs") as {
  notarizeAndStaple(
    app: string,
    env: Record<string, string | undefined>,
    deps: { run: Run; sleep: (ms: number) => Promise<void> },
  ): Promise<void>;
  verifyClaudeRuntime(app: string, deps: { run: Run }): void;
};

describe("verifyClaudeRuntime", () => {
  it("runs the signed ASAR entry without passing signing credentials to the subprocess", () => {
    const run = vi.fn<Run>(() => ({ status: 0, stdout: "" }));
    const app = join("/out", "F5 Test.app");
    verifyClaudeRuntime(app, { run });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      join(app, "Contents", "MacOS", "F5 Test"),
      [
        join(
          app,
          "Contents",
          "Resources",
          "app.asar",
          "apps",
          "server",
          "dist",
          "claude-runtime-smoke.mjs",
        ),
      ],
      {
        env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 45_000,
        killSignal: "SIGKILL",
      },
    );
  });

  it.each([1, null])("blocks notarization after an unsuccessful smoke check (%s)", (status) => {
    expect(() =>
      verifyClaudeRuntime("/out/F5.app", { run: () => ({ status, stdout: "" }) }),
    ).toThrow("Bundled Claude runtime smoke failed");
  });
});

const env = { APPLE_API_KEY: "/tmp/key.p8", APPLE_API_KEY_ID: "KEY", APPLE_API_ISSUER: "ISSUER" };
const accepted = { status: 0, stdout: '{"id":"abc","status":"Accepted"}\n' };

function harness(responses: Record<string, RunResult[]>) {
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  const delays: number[] = [];
  const run: Run = (command, args, options) => {
    calls.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
    const key = command === "xcrun" ? `${args[0]} ${args[1]}` : command;
    return responses[key]?.shift() ?? { status: 0, stdout: "" };
  };
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { calls, delays, deps: { run, sleep } };
}

describe("notarizeAndStaple", () => {
  it("submits with the API key and staples in the app directory", async () => {
    const { calls, delays, deps } = harness({ "notarytool submit": [accepted] });
    await notarizeAndStaple("/out/mac/F5.app", env, deps);
    expect(calls.map((call) => `${call.command} ${call.args[0]}`)).toEqual([
      "ditto -c",
      "xcrun notarytool",
      "xcrun stapler",
    ]);
    expect(calls[1]!.args).toEqual(
      expect.arrayContaining(["--key", "/tmp/key.p8", "--key-id", "KEY", "--issuer", "ISSUER"]),
    );
    expect(calls[2]).toEqual({
      command: "xcrun",
      args: ["stapler", "staple", "-v", "F5.app"],
      cwd: "/out/mac",
    });
    expect(delays).toEqual([]);
  });

  it("retries stapling with growing delays until the ticket service answers", async () => {
    const failure = { status: 68, stdout: "" };
    const { delays, deps } = harness({
      "notarytool submit": [accepted],
      "stapler staple": [failure, failure, failure, failure, failure],
    });
    await notarizeAndStaple("/out/F5.app", env, deps);
    expect(delays).toEqual([15_000, 30_000, 45_000, 60_000, 60_000]);
  });

  it("gives up after the last staple attempt", async () => {
    const failure = { status: 68, stdout: "" };
    const { deps } = harness({
      "notarytool submit": [accepted],
      "stapler staple": Array.from({ length: 6 }, () => failure),
    });
    await expect(notarizeAndStaple("/out/F5.app", env, deps)).rejects.toThrow(
      "Stapling failed after 6 attempts",
    );
  });

  it("resubmits when notarytool returns no verdict", async () => {
    const { calls, deps } = harness({
      "notarytool submit": [{ status: 1, stdout: "" }, accepted],
    });
    await notarizeAndStaple("/out/F5.app", env, deps);
    expect(calls.filter((call) => call.args[1] === "submit")).toHaveLength(2);
  });

  it("fails without retrying when Apple rejects the submission, and prints its log", async () => {
    const { calls, deps } = harness({
      "notarytool submit": [{ status: 0, stdout: '{"id":"abc","status":"Invalid"}' }],
    });
    await expect(notarizeAndStaple("/out/F5.app", env, deps)).rejects.toThrow(
      "finished with status Invalid",
    );
    expect(calls.filter((call) => call.args[1] === "submit")).toHaveLength(1);
    expect(calls.at(-1)!.args.slice(0, 3)).toEqual(["notarytool", "log", "abc"]);
    expect(calls.some((call) => call.args[0] === "stapler")).toBe(false);
  });

  it("requires every API credential", async () => {
    const { calls, deps } = harness({});
    await expect(
      notarizeAndStaple("/out/F5.app", { ...env, APPLE_API_ISSUER: undefined }, deps),
    ).rejects.toThrow("APPLE_API_ISSUER");
    expect(calls).toEqual([]);
  });
});
