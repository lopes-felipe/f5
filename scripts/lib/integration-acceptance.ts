import { join } from "node:path";
import {
  INTEGRATION_ACCEPTANCE_CHECKS,
  type ProviderIntegrationRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import { DEFAULT_QUIET_WINDOW, stoppedAfter } from "./mutation-fixture.ts";

/**
 * Operator acceptance of a release draft in the installed app. Each check is either
 * observed here (processes, manifest bytes, fixture hits) or confirmed by the operator;
 * nothing is inferred from F5's own UI or logs. The report records results only.
 */
export interface AcceptanceProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export interface AcceptanceIo {
  readonly say: (text: string) => void;
  /** A yes/no question; also used to wait until the operator has done a step. */
  readonly confirm: (question: string) => Promise<boolean>;
  readonly processes: () => Promise<ReadonlyArray<AcceptanceProcess>>;
  /** File contents, or null when absent. */
  readonly readFile: (path: string) => Promise<string | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface AcceptanceContext {
  readonly record: ProviderIntegrationRecord;
  readonly userHome: string;
  /** The installed F5.app the operator is testing. */
  readonly appPath: string;
  readonly fixture: {
    readonly origin: string;
    readonly hits: (marker: string) => ReadonlyArray<number>;
  };
}

export interface AcceptanceOutcome {
  readonly checks: Record<string, boolean>;
  /** Measurements behind the automatic checks, for the report. */
  readonly observations: Record<string, unknown>;
}

const hostNameOf = (record: ProviderIntegrationRecord) =>
  "hostName" in record.identity ? record.identity.hostName : undefined;

/** Native-messaging manifests the record's host would use, one per browser folder. */
export function manifestPaths(record: ProviderIntegrationRecord, userHome: string): string[] {
  const hostName = hostNameOf(record);
  if (!hostName) return [];
  return [
    ...new Set(
      record.browsers.map((browser) =>
        join(userHome, ...browser.nativeMessagingPath, `${hostName}.json`),
      ),
    ),
  ];
}

/**
 * The integration processes F5 started: what ⌃⌘Esc and idle stop must end. A process
 * counts only if it descends from the installed F5.app, so the ChatGPT app's own
 * `node_repl` or a terminal `claude` is never mistaken for F5's.
 */
export function integrationProcessMatcher(
  context: Pick<AcceptanceContext, "record" | "appPath">,
): (process: AcceptanceProcess, table: ReadonlyArray<AcceptanceProcess>) => boolean {
  const { record } = context;
  const inApp = (command: string) => command.startsWith(`${context.appPath}/`);
  const fromF5 = (process: AcceptanceProcess, table: ReadonlyArray<AcceptanceProcess>) => {
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const seen = new Set<number>();
    for (let parent = byPid.get(process.ppid); parent && !seen.has(parent.pid); ) {
      if (inApp(parent.command)) return true;
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
    return false;
  };
  switch (record.integration) {
    case "claude-chrome":
      // F5's bundled Claude CLI lives inside the app bundle. Chrome launches the same
      // executable as its native host; that one descends from Chrome, not F5.
      return (process, table) =>
        inApp(process.command) &&
        process.command.includes(record.identity.platformPackage) &&
        !record.identity.nativeHostArgs.some((arg) => process.command.includes(arg)) &&
        fromF5(process, table);
    case "codex-chrome":
      return (process, table) =>
        /\/cua_node\/bin\/node_repl(\s|$)/.test(process.command) && fromF5(process, table);
    case "codex-computer": {
      const client = (record.versions.clientPath ?? "").split("/").filter(Boolean).at(-1);
      return (process, table) =>
        client !== undefined && process.command.includes(`/${client}`) && fromF5(process, table);
    }
  }
}

const snapshot = async (paths: ReadonlyArray<string>, io: AcceptanceIo) =>
  Promise.all(paths.map((path) => io.readFile(path)));

/** Waits for a positive control, then for every matched process group to exit. */
async function stopsProcesses(
  match: ReturnType<typeof integrationProcessMatcher>,
  io: AcceptanceIo,
  instruction: string,
  trigger: string,
  withinMs: number,
): Promise<{ passed: boolean; observation: Record<string, unknown> }> {
  io.say(instruction);
  await io.confirm("Ready?");
  const table = await io.processes();
  const running = table.filter((process) => match(process, table));
  if (!running.length) return { passed: false, observation: { runningBefore: 0 } };
  const groups = new Set(running.map((process) => process.pgid));
  await io.confirm(trigger);
  const started = io.now();
  for (;;) {
    const left = (await io.processes()).filter((process) => groups.has(process.pgid));
    if (!left.length)
      return {
        passed: true,
        observation: { runningBefore: running.length, stoppedWithinMs: io.now() - started },
      };
    if (io.now() - started > withinMs)
      return { passed: false, observation: { runningBefore: running.length, left: left.length } };
    await io.sleep(250);
  }
}

export async function runAcceptanceChecklist(
  context: AcceptanceContext,
  io: AcceptanceIo,
): Promise<AcceptanceOutcome> {
  const { record } = context;
  const checks: Record<string, boolean> = {};
  const observations: Record<string, unknown> = {};
  const manifests = manifestPaths(record, context.userHome);
  // Before anything changes: restore and "unchanged" checks compare against this.
  const original = await snapshot(manifests, io);
  const matcher = integrationProcessMatcher(context);

  const automatic: Record<string, () => Promise<boolean>> = {
    "manifests-created": async () => {
      io.say("Turn on Claude in Chrome in F5 Settings and approve the setup consent.");
      await io.confirm("Done?");
      const origins = record.integration === "claude-chrome" ? record.identity.allowedOrigins : [];
      const written = await snapshot(manifests, io);
      const valid = written.map((bytes) => {
        try {
          const manifest = JSON.parse(bytes ?? "") as { name?: unknown; allowed_origins?: unknown };
          return (
            manifest.name === hostNameOf(record) &&
            JSON.stringify([...((manifest.allowed_origins as string[]) ?? [])].sort()) ===
              JSON.stringify([...origins].sort())
          );
        } catch {
          return false;
        }
      });
      observations["manifests-created"] = {
        expected: manifests.length,
        valid: valid.filter(Boolean).length,
      };
      return valid.length > 0 && valid.every(Boolean);
    },
    "restore-original-bytes": async () => {
      io.say("Turn off Claude in Chrome in F5 Settings and choose Restore.");
      await io.confirm("Done?");
      const now = await snapshot(manifests, io);
      const changed = now.filter((bytes, index) => bytes !== original[index]).length;
      observations["restore-original-bytes"] = { changed };
      return changed === 0;
    },
    "registrations-unchanged": async () => {
      const now = await snapshot(manifests, io);
      const changed = now.filter((bytes, index) => bytes !== original[index]).length;
      observations["registrations-unchanged"] = {
        changed,
        present: original.filter((bytes) => bytes !== null).length,
      };
      // Something must have been registered for "unchanged" to mean anything.
      return changed === 0 && original.some((bytes) => bytes !== null);
    },
    "emergency-stop": async () => {
      const result = await stopsProcesses(
        matcher,
        io,
        "Start a call that keeps running (for example, ask the agent to wait 60 seconds in the integration).",
        "Press ⌃⌘Esc now. Pressed?",
        5000,
      );
      observations["emergency-stop"] = result.observation;
      return result.passed;
    },
    "idle-stop": async () => {
      const result = await stopsProcesses(
        matcher,
        io,
        "Run one Codex Chrome call and let it finish.",
        "Leave the thread idle from now on. Confirm when the call has finished.",
        60_000 + 20_000,
      );
      observations["idle-stop"] = result.observation;
      return result.passed;
    },
    "pause-stops": async () => {
      const marker = `accept-${io.now()}`;
      const url = `${context.fixture.origin}/marker/${marker}`;
      io.say(
        `In a Codex thread with Chrome control on, send:\n  Use js to open a new Chrome tab, then start a setInterval every 250 ms that navigates that tab to ${url}?n=<a counter>, and reply STARTED.`,
      );
      const runningBy = io.now() + 180_000;
      while (
        context.fixture.hits(marker).length < DEFAULT_QUIET_WINDOW.minHitsBefore &&
        io.now() < runningBy
      )
        await io.sleep(250);
      if (context.fixture.hits(marker).length < DEFAULT_QUIET_WINDOW.minHitsBefore) {
        observations["pause-stops"] = { hitsBeforePause: context.fixture.hits(marker).length };
        return false;
      }
      await io.confirm("Background work is running. Press Pause in F5 now. Paused?");
      const stoppedAt = io.now();
      await io.sleep(DEFAULT_QUIET_WINDOW.settleMs + DEFAULT_QUIET_WINDOW.quietMs + 250);
      const hits = context.fixture.hits(marker);
      observations["pause-stops"] = {
        hitsBeforePause: hits.filter((time) => time <= stoppedAt).length,
        hitsAfterPause: hits.filter((time) => time > stoppedAt).length,
      };
      return stoppedAfter(hits, stoppedAt, io.now());
    },
  };

  for (const check of INTEGRATION_ACCEPTANCE_CHECKS[record.integration]) {
    io.say(`\n${check.label}${check.auto ? " (observed)" : ""}`);
    const observe = check.auto ? automatic[check.id] : undefined;
    if (check.auto && !observe) throw new Error(`No observer for the automatic check ${check.id}.`);
    checks[check.id] = observe ? await observe() : await io.confirm(`${check.label}?`);
    io.say(checks[check.id] ? "  passed" : "  FAILED");
  }
  return { checks, observations };
}

/** `CDHash=` from `codesign -dvvv` output (printed on stderr). */
export function cdhashFromCodesign(output: string): string | undefined {
  return /^CDHash=([a-f0-9]+)$/m.exec(output)?.[1];
}

/** The release's macOS DMG name, as `build-desktop-artifact.ts` writes it. */
export function macArtifactName(version: string, arch: string): string {
  return `F5-${version}-${arch}.dmg`;
}

/** One report per release, integration and target: each covers one architecture's DMG. */
export function acceptanceReportPath(
  version: string,
  integration: string,
  platform: string,
  arch: string,
): string {
  return `docs/computer-certification/acceptance-${version}-${integration}-${platform}-${arch}.json`;
}

export interface BundleIo {
  /** `codesign --verify --deep --strict`: the bundle is intact against its seal. */
  readonly verify: (app: string) => boolean;
  readonly cdhash: (app: string) => string | undefined;
  readonly version: (app: string) => string | undefined;
}

/**
 * Why the installed app is not the artifact being accepted, or undefined when it is. Both
 * bundles must verify first: the displayed CDHash alone doesn't prove sealed resources or
 * nested helpers are unchanged.
 */
export function installedAppMismatch(
  installed: string,
  mounted: string,
  version: string,
  io: BundleIo,
): string | undefined {
  if (!io.verify(mounted)) return `The app in the DMG fails code-signature verification.`;
  if (!io.verify(installed))
    return `${installed} fails code-signature verification. Reinstall it from the draft's DMG.`;
  const hash = io.cdhash(installed);
  if (!hash || hash !== io.cdhash(mounted))
    return `${installed} is not the app in this DMG. Install the draft's DMG first.`;
  const installedVersion = io.version(installed);
  if (installedVersion !== version)
    return `${installed} is version ${installedVersion ?? "unknown"}, not ${version}.`;
  return undefined;
}
