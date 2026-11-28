/**
 * Antigravity subscription limits from the CLI's own `/usage` command, run on request only.
 *
 * F5 never calls Google's quota APIs (`cloudcode-pa` `retrieveUserQuotaSummary` /
 * `fetchAvailableModels`) and never reads the sign-in token: Google warned those direct calls can
 * flag accounts. `antigravity -p /usage` is the CLI's supported command, so the CLI makes its own
 * lookup with its own client. The reader is off unless the instance opts in.
 */
// The run's shadow home is plain filesystem setup next to the spawned CLI.
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  AccountUsageErrorCode,
  AccountUsageSection,
  ProviderInstanceId,
  ProviderUsageWindow,
  UsageAccount,
} from "@t3tools/contracts";
import { compareVersions } from "@t3tools/shared/providerIntegrationCertification";
import { Effect } from "effect";
import type { Scope } from "effect/Scope";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";
import { emptyAccountSection, makeAccountUsageCapability } from "./Layers/AccountUsageService.ts";
import { accountUsageIdentity, type AccountUsageCapability } from "./accountUsage.ts";
import { AccountUsageReadError } from "./accountUsageErrors.ts";
import { asRecord, asTrimmedString, resetDate } from "./accountUsageJson.ts";
import { mergeProviderUsageWindows } from "./providerUsageWindows.ts";

/** The oldest CLI whose `/usage --output-format json` report was checked to spend no turn. */
export const ANTIGRAVITY_USAGE_MIN_VERSION = "1.5.15";
export const ANTIGRAVITY_USAGE_ARGS = [
  "-p",
  "/usage",
  "--output-format",
  "json",
  "--print-timeout",
  "25s",
] as const;
export const ANTIGRAVITY_USAGE_TIMEOUT_MS = 30_000;
/** No run starts within this long of the previous one, forced refreshes included. */
export const ANTIGRAVITY_USAGE_MIN_INTERVAL_MS = 60_000;
/** A quota stop with no reset time is shown this long: the shortest Antigravity window. */
export const ANTIGRAVITY_QUOTA_SIGNAL_FALLBACK_MS = 5 * 60 * 60_000;

const WEEK_MINUTES = 7 * 24 * 60;
const FIVE_HOURS_MINUTES = 5 * 60;
// Untouched buckets report the Unix epoch as their reset time.
const EARLIEST_REAL_RESET_MS = Date.UTC(2000, 0, 1);
const SIGNED_OUT =
  /authentication required|authentication failed|not signed in|sign in to|please (?:log|sign) ?in|unauthenticated/i;

export type AntigravityUsageReport =
  | { readonly kind: "windows"; readonly windows: ReadonlyArray<ProviderUsageWindow> }
  | {
      readonly kind: "failed";
      readonly errorCode: AccountUsageErrorCode;
      /** The CLI answered `/usage` with a model turn; never ask this runtime version again. */
      readonly spentTurn?: true;
    };

const failed = (errorCode: AccountUsageErrorCode): AntigravityUsageReport => ({
  kind: "failed",
  errorCode,
});

function parseJson(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  const candidates = [text, text.slice(text.lastIndexOf("\n{") + 1)];
  for (const candidate of candidates) {
    try {
      const value = asRecord(JSON.parse(candidate));
      if (value) return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function family(groupName: string | null, bucketId: string): string {
  if (bucketId.startsWith("gemini-argon-")) return groupName ?? "Gemini Argon";
  if (bucketId.startsWith("gemini-")) return "Gemini";
  if (bucketId.startsWith("3p-")) return "Claude & GPT (shared)";
  return groupName ?? bucketId;
}

function bucketReset(value: unknown): string | null {
  const reset = resetDate(value);
  return reset !== null && Date.parse(reset) >= EARLIEST_REAL_RESET_MS ? reset : null;
}

/**
 * Reads `antigravity -p /usage --output-format json`. Window ids and labels match the quota
 * summary F5 read before 0.1.13, so labels and the sidebar's weekly pick stay the same. Never log
 * the report: it can name the account.
 */
export function parseAntigravityUsageReport(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): AntigravityUsageReport {
  const report = parseJson(stdout);
  const signedOut =
    SIGNED_OUT.test(stderr) || SIGNED_OUT.test(asTrimmedString(report?.error) ?? "");
  if (!report) {
    if (exitCode === 2) return failed("unsupported");
    return failed(signedOut ? "authentication-required" : "invalid-response");
  }
  const turns = typeof report.num_turns === "number" ? report.num_turns : 0;
  const tokens = asRecord(report.usage)?.total_tokens;
  if (turns > 0 || (typeof tokens === "number" && tokens > 0))
    return { kind: "failed", errorCode: "unsupported", spentTurn: true };
  // A Gemini API key has no account quota; the CLI exits 2 and explains why.
  if (exitCode === 2) return failed("unsupported");
  const command = asRecord(report.command);
  const groups = asRecord(command?.data)?.groups;
  if (report.status !== "SUCCESS" || command?.name !== "usage" || !Array.isArray(groups))
    return failed(signedOut ? "authentication-required" : "invalid-response");
  const windows = groups.flatMap((value): Array<ProviderUsageWindow> => {
    const group = asRecord(value);
    const groupName = asTrimmedString(group?.name);
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
    return buckets.flatMap((entry): Array<ProviderUsageWindow> => {
      const bucket = asRecord(entry);
      const id = asTrimmedString(bucket?.id);
      const remaining = bucket?.remaining_fraction;
      if (!id || bucket?.disabled === true) return [];
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) return [];
      const durationMinutes =
        bucket?.window === "weekly"
          ? WEEK_MINUTES
          : bucket?.window === "5h"
            ? FIVE_HOURS_MINUTES
            : null;
      const label =
        bucket?.window === "weekly"
          ? "Weekly"
          : bucket?.window === "5h"
            ? "5-hour"
            : (asTrimmedString(bucket?.name) ?? "Quota");
      return [
        {
          id,
          label: `${family(groupName, id)} · ${label}`,
          usedPercent: Math.max(0, Math.min(100, (1 - remaining) * 100)),
          resetsAt: bucketReset(bucket?.reset_time),
          ...(durationMinutes !== null ? { durationMinutes } : {}),
        },
      ];
    });
  });
  return windows.length
    ? { kind: "windows", windows: mergeProviderUsageWindows([windows]) }
    : failed("invalid-response");
}

/**
 * The 1.5 CLI's print mode reads `$HOME/.gemini/antigravity-cli` and has no flag for another
 * directory, while F5 keeps each instance's sign-in in `<profile>/antigravity-acp`. Each run gets
 * a temporary home whose `.gemini` links to the profile: the same files, nothing copied, and the
 * profile layout untouched. The links and the run's working and temp folders are removed after.
 */
export async function runAntigravityUsageCommand(input: {
  readonly executablePath: string;
  readonly profileDirectory: string;
  /** The instance's launch environment (`antigravityEnvironment`). */
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ProcessRunResult> {
  const runtime = await fs.mkdtemp(path.join(input.profileDirectory, ".runtime-"));
  try {
    const home = path.join(runtime, "home");
    const cwd = path.join(runtime, "cwd");
    const temp = path.join(runtime, "tmp");
    await fs.mkdir(path.join(home, ".gemini"), { recursive: true, mode: 0o700 });
    await fs.mkdir(cwd, { mode: 0o700 });
    await fs.mkdir(temp, { mode: 0o700 });
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(
      path.join(input.profileDirectory, "antigravity-acp"),
      path.join(home, ".gemini", "antigravity-cli"),
      linkType,
    );
    const config = path.join(input.profileDirectory, "config");
    if (
      await fs.stat(config).then(
        (stat) => stat.isDirectory(),
        () => false,
      )
    )
      await fs.symlink(config, path.join(home, ".gemini", "config"), linkType);
    return await runProcess(input.executablePath, ANTIGRAVITY_USAGE_ARGS, {
      cwd,
      env: {
        ...input.environment,
        HOME: home,
        ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
      },
      // An empty stdin ends the CLI's sign-in prompt instead of leaving it waiting.
      stdin: "",
      timeoutMs: input.timeoutMs ?? ANTIGRAVITY_USAGE_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: 1024 * 1024,
      outputMode: "truncate",
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    await fs.rm(runtime, { recursive: true, force: true });
  }
}

/** Gate and outcome for a reader that did not run, before any process starts. */
export function antigravityUsageVersionIssue(
  version: string | null,
  refusedVersion: string | undefined,
): "cli-too-old" | "cli-spends-turn" | null {
  if (version !== null && refusedVersion === version) return "cli-spends-turn";
  const comparison = compareVersions(version ?? undefined, ANTIGRAVITY_USAGE_MIN_VERSION);
  return comparison === undefined || comparison < 0 ? "cli-too-old" : null;
}

export interface AntigravityQuotaSignal {
  readonly observedAt: string;
  readonly resetsAt: string | null;
}

/** The passive quota stop, while it still applies at `now`. */
export function activeQuotaSignal(
  signal: AntigravityQuotaSignal | undefined,
  now: number,
): AntigravityQuotaSignal | undefined {
  if (!signal) return undefined;
  const until = signal.resetsAt
    ? Date.parse(signal.resetsAt)
    : Date.parse(signal.observedAt) + ANTIGRAVITY_QUOTA_SIGNAL_FALLBACK_MS;
  return Number.isFinite(until) && until > now ? signal : undefined;
}

/**
 * Adds the passive quota stop to the account's limits section. A successful limits reading taken
 * after the stop replaces it: it shows the real quota.
 */
export function withQuotaSignal(
  account: UsageAccount,
  signal: AntigravityQuotaSignal | undefined,
  now: number,
): UsageAccount {
  const active = activeQuotaSignal(signal, now);
  if (!active) return account;
  return {
    ...account,
    sections: account.sections.map((section) => {
      if (section.kind !== "provider-limits") return section;
      const newerReading =
        section.outcome === "available" &&
        section.snapshot !== null &&
        section.snapshot.data.windows.length > 0 &&
        section.snapshot.fetchedAt > active.observedAt;
      return newerReading
        ? section
        : {
            ...section,
            quotaExhausted: { observedAt: active.observedAt, resetsAt: active.resetsAt },
          };
    }),
  };
}

export interface AntigravityLimitsInput {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly enabled: boolean;
  /** The instance profile key: each Antigravity account keeps its own history. */
  readonly profileKey: string;
  readonly billedPerToken: boolean;
  readonly readLimitsWithCli: boolean;
  /** The quota stop the driver last observed from a turn. */
  readonly quotaSignal: () => AntigravityQuotaSignal | undefined;
  /**
   * Runs `/usage` for the instance: the driver gates sign-in, admission and stale settings, then
   * spawns through `runAntigravityUsageCommand`. Fails with `AccountUsageReadError`.
   */
  readonly runUsage?: (signal: AbortSignal) => Promise<ProcessRunResult>;
  readonly runtimeVersion?: () => Promise<string | null>;
  readonly refusedVersion?: () => Promise<string | undefined>;
  readonly refuseVersion?: (version: string) => Promise<void>;
  readonly now?: () => number;
}

export function antigravityLimitsIdentity(profileKey: string): string {
  return accountUsageIdentity("antigravity", ["profile", profileKey]);
}

type LimitsSection = Extract<AccountUsageSection, { kind: "provider-limits" }>;
const limitsSection = (fields: Partial<Omit<LimitsSection, "kind">>): LimitsSection => ({
  kind: "provider-limits",
  outcome: "unavailable",
  lastAttemptAt: null,
  snapshot: null,
  errorCode: null,
  ...fields,
});

/** Limits capability for one Antigravity instance. */
export function makeAntigravityLimits(
  input: AntigravityLimitsInput,
): Effect.Effect<AccountUsageCapability, never, Scope> {
  const now = input.now ?? Date.now;
  const initial: UsageAccount = {
    key: `antigravity:${input.instanceId}`,
    provider: "antigravity",
    providerInstanceId: input.instanceId,
    displayName: input.displayName,
    enabled: input.enabled,
    refreshState: "idle",
    sections: [emptyAccountSection("provider-limits")],
  };
  const identity = antigravityLimitsIdentity(input.profileKey);
  const withSignal = (account: UsageAccount) =>
    withQuotaSignal(account, input.quotaSignal(), now());
  const fixed = (section: AccountUsageSection): AccountUsageCapability => ({
    identity,
    getSnapshot: Effect.sync(() => withSignal({ ...initial, sections: [section] })),
    refresh: () => Effect.void,
  });
  if (input.billedPerToken) {
    const fetchedAt = new Date(now()).toISOString();
    return Effect.succeed(
      fixed(
        limitsSection({
          outcome: "available",
          lastAttemptAt: fetchedAt,
          snapshot: { fetchedAt, data: { windows: [], plan: "Billed per token" } },
        }),
      ),
    );
  }
  if (!input.readLimitsWithCli || !input.runUsage) {
    return Effect.succeed(
      fixed(
        limitsSection({ outcome: "unsupported", errorCode: "unsupported", readsDisabled: true }),
      ),
    );
  }
  const runUsage = input.runUsage;
  let last: {
    readonly at: number;
    readonly outcome: ReadonlyArray<AccountUsageSection> | AccountUsageReadError;
  } | null = null;
  const unsupported = (
    reason: "cli-too-old" | "cli-spends-turn",
    at: string,
  ): ReadonlyArray<AccountUsageSection> => [
    limitsSection({
      outcome: "unsupported",
      errorCode: "unsupported",
      lastAttemptAt: at,
      unsupportedReason: reason,
    }),
  ];
  const attempt = async (signal: AbortSignal): Promise<ReadonlyArray<AccountUsageSection>> => {
    const at = new Date(now()).toISOString();
    const version = (await input.runtimeVersion?.()) ?? null;
    const issue = antigravityUsageVersionIssue(version, await input.refusedVersion?.());
    if (issue) return unsupported(issue, at);
    const result = await runUsage(signal);
    if (result.aborted) throw new AccountUsageReadError("temporary-failure");
    const report = result.timedOut
      ? SIGNED_OUT.test(result.stderr)
        ? failed("authentication-required")
        : failed("timeout")
      : parseAntigravityUsageReport(result.stdout, result.stderr, result.code);
    if (report.kind === "failed") {
      if (report.spentTurn && version !== null) {
        await input.refuseVersion?.(version);
        return unsupported("cli-spends-turn", at);
      }
      throw new AccountUsageReadError(report.errorCode);
    }
    const fetchedAt = new Date(now()).toISOString();
    return [
      {
        kind: "provider-limits",
        outcome: "available",
        errorCode: null,
        lastAttemptAt: fetchedAt,
        snapshot: { fetchedAt, data: { windows: report.windows } },
      },
    ];
  };
  const read = Effect.tryPromise({
    try: async (signal) => {
      // Within the floor, replay the last outcome, failures included, so neither a forced
      // refresh nor a broken CLI starts runs back to back.
      if (last && now() - last.at < ANTIGRAVITY_USAGE_MIN_INTERVAL_MS) {
        if (last.outcome instanceof AccountUsageReadError) throw last.outcome;
        return last.outcome;
      }
      const startedAt = now();
      try {
        const sections = await attempt(signal);
        last = { at: startedAt, outcome: sections };
        return sections;
      } catch (error) {
        const readError =
          error instanceof AccountUsageReadError
            ? error
            : new AccountUsageReadError("temporary-failure");
        // An interrupted run proves nothing about the CLI; the next refresh may run at once.
        last = signal.aborted ? null : { at: startedAt, outcome: readError };
        throw readError;
      }
    },
    catch: (error) =>
      error instanceof AccountUsageReadError
        ? error
        : new AccountUsageReadError("temporary-failure"),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Antigravity /usage limits read failed.", { errorCode: error.code }),
    ),
  );
  return makeAccountUsageCapability(initial, read, {
    identity,
    readerOwnsTimeout: true,
    retryFailedReads: true,
  }).pipe(
    Effect.map(
      (capability): AccountUsageCapability => ({
        ...capability,
        getSnapshot: Effect.map(capability.getSnapshot, withSignal),
        ...(capability.refreshAccount
          ? {
              refreshAccount: (permits, mode) =>
                Effect.map(capability.refreshAccount!(permits, mode), (result) => ({
                  ...result,
                  snapshot: withSignal(result.snapshot),
                })),
            }
          : {}),
      }),
    ),
  );
}
