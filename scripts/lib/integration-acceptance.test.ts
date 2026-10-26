import { describe, expect, it } from "vitest";
import {
  INTEGRATION_ACCEPTANCE_CHECKS,
  PROVIDER_INTEGRATION_RECORDS,
} from "@t3tools/shared/providerIntegrationCertification";
import {
  cdhashFromCodesign,
  installedAppMismatch,
  integrationProcessMatcher,
  macArtifactName,
  manifestPaths,
  runAcceptanceChecklist,
  type AcceptanceIo,
  type AcceptanceProcess,
} from "./integration-acceptance.ts";

const APP = "/Applications/F5.app";
const HOME = "/Users/me";
const codex = PROVIDER_INTEGRATION_RECORDS["codex-chrome"][0]!;
const claude = PROVIDER_INTEGRATION_RECORDS["claude-chrome"][0]!;
const NODE_REPL = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl";
const f5 = { pid: 10, ppid: 1, pgid: 10, command: `${APP}/Contents/MacOS/F5` };
const server = { pid: 11, ppid: 10, pgid: 10, command: `${APP}/Contents/Resources/server` };

/**
 * A scripted operator and machine. `onConfirm` runs when the operator answers, so a test
 * can make the effect of their action (a stop, a restore) visible to the next observation.
 */
function harness(input: {
  processes: AcceptanceProcess[];
  files?: Record<string, string>;
  answers?: (question: string) => boolean;
  onConfirm?: (
    question: string,
    state: { processes: AcceptanceProcess[]; files: Record<string, string> },
  ) => void;
  hits?: (marker: string, now: number) => number[];
}) {
  const state = { processes: input.processes, files: { ...input.files } };
  let clock = 1_000_000;
  const asked: string[] = [];
  const io: AcceptanceIo = {
    say: () => {},
    confirm: async (question) => {
      asked.push(question);
      input.onConfirm?.(question, state);
      return input.answers?.(question) ?? true;
    },
    processes: async () => state.processes,
    readFile: async (path) => state.files[path] ?? null,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  const fixture = {
    origin: "http://127.0.0.1:1",
    hits: (marker: string) => input.hits?.(marker, clock) ?? [],
  };
  return { io, state, asked, fixture };
}

describe("acceptance checklist", () => {
  it("observes every automatic Codex Chrome check and asks only the rest", async () => {
    const manifests = manifestPaths(codex, HOME);
    const registration = JSON.stringify({ name: codex.identity.hostName });
    const repl = { pid: 20, ppid: 11, pgid: 20, command: NODE_REPL };
    let pausedAt: number | undefined;
    const { io, asked, fixture } = harness({
      processes: [f5, server, repl],
      files: { [manifests[0]!]: registration },
      onConfirm: (question, state) => {
        if (question.startsWith("Press ⌃⌘Esc") || question.startsWith("Leave the thread idle"))
          state.processes = [f5, server];
        if (question.startsWith("Ready?")) state.processes = [f5, server, repl];
        if (question.startsWith("Background work is running")) pausedAt = 1;
      },
      // Running every 250 ms until the pause (at 1_000_000), one in-flight landing, then quiet.
      hits: (_marker, now) =>
        pausedAt === undefined
          ? [now - 750, now - 500, now - 250]
          : [999_250, 999_500, 999_750, 1_001_000],
    });
    const outcome = await runAcceptanceChecklist(
      { record: codex, userHome: HOME, appPath: APP, fixture },
      io,
    );
    expect(outcome.checks).toEqual(
      Object.fromEntries(
        INTEGRATION_ACCEPTANCE_CHECKS["codex-chrome"].map((check) => [check.id, true]),
      ),
    );
    // Manual checks are asked by label; automatic ones never are.
    for (const check of INTEGRATION_ACCEPTANCE_CHECKS["codex-chrome"])
      expect(asked.includes(`${check.label}?`)).toBe(!check.auto);
  });

  it("fails a stop when no F5-started process was running, or one survives", async () => {
    const chatGptOwn = { pid: 30, ppid: 29, pgid: 30, command: NODE_REPL };
    const none = harness({ processes: [f5, server, chatGptOwn] });
    const fixture = none.fixture;
    const outcome = await runAcceptanceChecklist(
      { record: codex, userHome: HOME, appPath: APP, fixture },
      none.io,
    );
    // The ChatGPT app's own node_repl is not F5's.
    expect(outcome.checks["emergency-stop"]).toBe(false);
    expect(outcome.observations["emergency-stop"]).toEqual({ runningBefore: 0 });

    const repl = { pid: 20, ppid: 11, pgid: 20, command: NODE_REPL };
    const stuck = harness({ processes: [f5, server, repl] });
    const result = await runAcceptanceChecklist(
      { record: codex, userHome: HOME, appPath: APP, fixture: stuck.fixture },
      stuck.io,
    );
    expect(result.checks["emergency-stop"]).toBe(false);
    expect(result.checks["idle-stop"]).toBe(false);
    // No registration existed, so "unchanged" proves nothing.
    expect(result.checks["registrations-unchanged"]).toBe(false);
    // No fixture hits: background work was never shown running.
    expect(result.checks["pause-stops"]).toBe(false);
  });

  it("fails pause when background work keeps landing after it", async () => {
    let pausedAt: number | undefined;
    const { io, fixture } = harness({
      processes: [f5, server],
      onConfirm: (question) => {
        if (question.startsWith("Background work is running")) pausedAt = 1_000_000;
      },
      // Running before the pause at 1_000_000, still landing 5 s after it.
      hits: (_marker, now) =>
        pausedAt === undefined
          ? [now - 500, now - 250, now]
          : [999_000, 999_250, 999_500, 1_005_000],
    });
    const outcome = await runAcceptanceChecklist(
      { record: codex, userHome: HOME, appPath: APP, fixture },
      io,
    );
    expect(outcome.checks["pause-stops"]).toBe(false);
  });

  it("checks Claude manifests and byte-for-byte restore against the starting snapshot", async () => {
    const manifests = manifestPaths(claude, HOME);
    expect(manifests).toHaveLength(7);
    const original = { [manifests[0]!]: "user's own bytes" };
    const written = JSON.stringify({
      name: claude.identity.hostName,
      allowed_origins: claude.identity.allowedOrigins,
    });
    const cli = {
      pid: 40,
      ppid: 11,
      pgid: 40,
      command: `${APP}/Contents/Resources/app.asar.unpacked/node_modules/${claude.identity.platformPackage}/claude`,
    };
    const terminalClaude = {
      pid: 50,
      ppid: 49,
      pgid: 50,
      command: "/opt/homebrew/bin/claude --chrome",
    };
    const { io, fixture } = harness({
      processes: [f5, server, cli, terminalClaude],
      files: original,
      onConfirm: (question, state) => {
        if (question === "Done?" && state.files[manifests[1]!] === undefined)
          state.files = Object.fromEntries(manifests.map((path) => [path, written]));
        else if (question === "Done?") state.files = { ...original };
        if (question.startsWith("Press ⌃⌘Esc")) state.processes = [f5, server, terminalClaude];
      },
    });
    const outcome = await runAcceptanceChecklist(
      { record: claude, userHome: HOME, appPath: APP, fixture },
      io,
    );
    expect(outcome.checks).toMatchObject({
      "manifests-created": true,
      "emergency-stop": true,
      "restore-original-bytes": true,
    });
  });
});

describe("integration process matching", () => {
  it("requires an F5 ancestor for Codex runtimes and the app bundle for Claude", () => {
    const codexMatch = integrationProcessMatcher({ record: codex, appPath: APP });
    const ours = { pid: 20, ppid: 11, pgid: 20, command: `${NODE_REPL} --flag` };
    const theirs = { pid: 21, ppid: 99, pgid: 21, command: NODE_REPL };
    const table = [f5, server, ours, theirs];
    expect(codexMatch(ours, table)).toBe(true);
    expect(codexMatch(theirs, table)).toBe(false);
    const claudeMatch = integrationProcessMatcher({ record: claude, appPath: APP });
    expect(claudeMatch({ ...ours, command: "/usr/local/bin/claude" }, table)).toBe(false);
  });

  it("never counts Chrome's native host, which runs F5's bundled CLI too", () => {
    const cliPath = `${APP}/Contents/Resources/app.asar.unpacked/node_modules/${claude.identity.platformPackage}/claude`;
    const chrome = {
      pid: 60,
      ppid: 1,
      pgid: 60,
      command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    };
    const session = { pid: 40, ppid: 11, pgid: 40, command: `${cliPath} --chrome` };
    const nativeHost = {
      pid: 61,
      ppid: 60,
      pgid: 60,
      command: `${cliPath} --chrome-native-host chrome-extension://abc/`,
    };
    // Even if it were somehow parented under F5, the native-host invocation is excluded.
    const adopted = { ...nativeHost, pid: 62, ppid: 11, pgid: 62 };
    const table = [f5, server, chrome, session, nativeHost, adopted];
    const match = integrationProcessMatcher({ record: claude, appPath: APP });
    expect(table.filter((process) => match(process, table))).toEqual([session]);
  });
});

describe("installed app identity", () => {
  const MOUNTED = "/tmp/mount/F5.app";
  const io = (patch: { invalid?: string; cdhash?: Record<string, string>; version?: string }) => ({
    verify: (app: string) => app !== patch.invalid,
    cdhash: (app: string) => patch.cdhash?.[app] ?? "abc123",
    version: () => patch.version ?? "1.2.3",
  });
  it("requires both bundles to verify before comparing their CDHash", () => {
    expect(installedAppMismatch(APP, MOUNTED, "1.2.3", io({}))).toBeUndefined();
    // A modified installed bundle keeps its displayed CDHash; verification catches it.
    expect(installedAppMismatch(APP, MOUNTED, "1.2.3", io({ invalid: APP }))).toContain(
      "fails code-signature verification",
    );
    expect(installedAppMismatch(APP, MOUNTED, "1.2.3", io({ invalid: MOUNTED }))).toContain(
      "DMG fails",
    );
    expect(
      installedAppMismatch(APP, MOUNTED, "1.2.3", io({ cdhash: { [APP]: "other" } })),
    ).toContain("is not the app in this DMG");
    expect(installedAppMismatch(APP, MOUNTED, "1.2.3", io({ version: "1.2.2" }))).toContain(
      "is version 1.2.2",
    );
  });
});

describe("release artifact identity", () => {
  it("reads codesign's CDHash and names the DMG like the release build", () => {
    expect(
      cdhashFromCodesign("Executable=/Applications/F5.app\nCDHash=0123abcd\nSignature size=9000\n"),
    ).toBe("0123abcd");
    expect(cdhashFromCodesign("no hash here")).toBeUndefined();
    expect(macArtifactName("1.2.3", "arm64")).toBe("F5-1.2.3-arm64.dmg");
  });
});
