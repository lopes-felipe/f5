import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
const { notarizeAndStaple, verifyDockTilePlugIn } = require("./notarize-mac.cjs") as {
  notarizeAndStaple(
    app: string,
    env: Record<string, string | undefined>,
    deps: { run: Run; sleep: (ms: number) => Promise<void> },
  ): Promise<void>;
  verifyDockTilePlugIn(
    app: string,
    deps: {
      run: (command: string, args: string[]) => { status: number | null; output: string };
      exists: (path: string) => boolean;
    },
  ): void;
};

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

describe("verifyDockTilePlugIn", () => {
  // Joined like the hook joins them, so the test also runs on a Windows runner.
  const app = join("/out/mac", "F5.app");
  const plugIn = join(app, "Contents/PlugIns/F5DockTile.docktileplugin");
  // Shapes of real `codesign -dvvv` output (it prints to stderr; the hook reads both).
  const released = (team: string) =>
    [
      "Format=bundle with Mach-O universal (x86_64 arm64)",
      "CodeDirectory v=20500 size=355 flags=0x10000(runtime) hashes=4+3 location=embedded",
      `Authority=Developer ID Application: Example (${team})`,
      "Timestamp=26 Nov 2026 at 14:55:39",
      `TeamIdentifier=${team}`,
    ].join("\n");
  const adHoc = [
    "Format=bundle with Mach-O universal (x86_64 arm64)",
    "CodeDirectory v=20400 size=355 flags=0x20002(adhoc,linker-signed) hashes=4+3 location=embedded",
    "Signature=adhoc",
    "TeamIdentifier=not set",
  ].join("\n");

  function codesign(outputs: { verify?: number; plugIn?: string; app?: string }) {
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "--verify") return { status: outputs.verify ?? 0, output: "" };
      return { status: 0, output: args[1] === app ? (outputs.app ?? "") : (outputs.plugIn ?? "") };
    };
    return { calls, run };
  }

  it("accepts a plug-in signed by the app's team with a timestamp and hardened runtime", () => {
    const { calls, run } = codesign({ plugIn: released("TEAM1"), app: released("TEAM1") });
    const seen: string[] = [];
    verifyDockTilePlugIn(app, {
      run,
      exists: (path) => {
        seen.push(path);
        return true;
      },
    });
    expect(seen).toEqual([join(plugIn, "Contents/MacOS/F5DockTile")]);
    expect(calls).toEqual([
      ["--verify", "--strict", plugIn],
      ["-dvvv", plugIn],
      ["-dvvv", app],
    ]);
  });

  it("rejects the ad hoc signature clang leaves, which passes --verify", () => {
    const { run } = codesign({ plugIn: adHoc, app: released("TEAM1") });
    expect(() => verifyDockTilePlugIn(app, { run, exists: () => true })).toThrow(
      /not signed for release \(it has no team identifier; it has no secure timestamp; it is not signed with hardened runtime\)/,
    );
  });

  it("rejects a plug-in signed by another team", () => {
    const { run } = codesign({ plugIn: released("OTHER"), app: released("TEAM1") });
    expect(() => verifyDockTilePlugIn(app, { run, exists: () => true })).toThrow(
      "its team OTHER is not the app's TEAM1",
    );
  });

  it("fails when the plug-in was not packaged, without calling codesign", () => {
    const { calls, run } = codesign({});
    expect(() => verifyDockTilePlugIn(app, { run, exists: () => false })).toThrow(
      `Packaged Dock tile plug-in missing: ${plugIn}`,
    );
    expect(calls).toEqual([]);
  });

  it("fails when the plug-in's signature is broken", () => {
    const { run } = codesign({ verify: 1, plugIn: released("TEAM1"), app: released("TEAM1") });
    expect(() => verifyDockTilePlugIn(app, { run, exists: () => true })).toThrow(
      "Dock tile plug-in signing verification failed",
    );
  });
});

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
