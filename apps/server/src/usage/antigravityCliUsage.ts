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
const RUN_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TMP",
  "TEMP",
]);
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
  const usage = asRecord(report.usage);
  const spentTokens = Object.values(usage ?? {}).some(
    (value) => typeof value === "number" && value > 0,
  );
  if (turns > 0 || spentTokens)
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
    // Windows keys are case-insensitive: drop every spelling of the home and temp variables so
    // the run's values are the only ones the CLI can see.
    const environment = Object.fromEntries(
      Object.entries(input.environment).filter(
        ([key]) => !RUN_ENVIRONMENT_KEYS.has(key.toUpperCase()),
      ),
    );
    return await runProcess(input.executablePath, ANTIGRAVITY_USAGE_ARGS, {
      cwd,
      env: {
        ...environment,
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
    // Links are removed, never followed: `rm` unlinks symlinks and junctions. A lingering handle
    // (antivirus, a child still exiting) must not turn a finished run into a failure.
    await fs
      .rm(runtime, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      .catch((cause: unknown) =>
        Effect.runPromise(
          Effect.logWarning("Could not remove an Antigravity /usage run folder.", {
            code: (cause as NodeJS.ErrnoException | undefined)?.code,
          }),
        ),
      );
  }
}

/** Whether a runtime version is new enough for the `/usage` report F5 checked. */
export function antigravityUsageVersionSupported(version: string): boolean {
  const comparison = compareVersions(version, ANTIGRAVITY_USAGE_MIN_VERSION);
  return comparison !== undefined && comparison >= 0;
}

export type AntigravityUsageRefusal = "cli-spends-turn" | "cli-unrecognized";

export interface AntigravityQuotaSignal {
  readonly observedAt: string;
  readonly resetsAt: string | null;
  /** The account (`antigravityAccountKey`) the turn ran under; another account never shows it. */
  readonly account?: string;
}

/** What the driver hands a `/usage` run: the resolved executable and account, under admission. */
export interface AntigravityUsageRunContext {
  /** The version of the executable `spawn` runs, resolved once for both gate and refusal. */
  readonly version: string | null;
  readonly account: string;
  readonly spawn: () => Promise<ProcessRunResult>;
}

/**
 * Runs `body` with the instance's account admission held until it returns, after checking the
 * sign-in settings and readiness. Fails with `AccountUsageReadError` before `body` runs, and
 * discards a run that straddled an account change.
 */
export type AntigravityUsageRun = <A>(
  signal: AbortSignal,
  body: (context: AntigravityUsageRunContext) => Promise<A>,
) => Promise<A>;

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
 * Adds the passive quota stop to the account's limits section. A limits reading taken after the
 * stop replaces it, even when a later refresh failed and kept that reading: it shows the real
 * quota. A stop observed under another account is never shown.
 */
export function withQuotaSignal(
  account: UsageAccount,
  signal: AntigravityQuotaSignal | undefined,
  now: number,
  currentAccount?: string,
): UsageAccount {
  const active = activeQuotaSignal(signal, now);
  if (!active) return account;
  if (active.account !== undefined && active.account !== currentAccount) return account;
  return {
    ...account,
    sections: account.sections.map((section) => {
      if (section.kind !== "provider-limits") return section;
      const newerReading =
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
  /** The account behind the profile now (`antigravityAccountKey`). */
  readonly currentAccount: () => Promise<string | undefined>;
  /** Runs `/usage` under the driver's gates (`makeAntigravityUsageRun`). */
  readonly usageRun?: AntigravityUsageRun;
  /** The persisted refusal, if any (`usageCommandRefused` in the auth state). */
  readonly refusal?: () => Promise<
    { readonly version: string; readonly reason: AntigravityUsageRefusal } | undefined
  >;
  readonly refuse?: (version: string, reason: AntigravityUsageRefusal) => Promise<void>;
  readonly verifiedVersion?: () => Promise<string | undefined>;
  readonly verify?: (version: string) => Promise<void>;
  readonly now?: () => number;
}

/** History identity when no account is known; it never matches an account's stored history. */
export function antigravityLimitsIdentity(profileKey: string): string {
  return accountUsageIdentity("antigravity", ["profile", profileKey]);
}

/** History identity for one account, shared by every instance signed in to it. */
export function antigravityAccountLimitsIdentity(account: string): string {
  return accountUsageIdentity("antigravity", ["account", account]);
}

function sectionAccount(section: AccountUsageSection): string | undefined {
  if (section.kind !== "provider-limits") return undefined;
  return section.snapshot?.data.accountFingerprint ?? section.accountFingerprint;
}

/**
 * Binds the limits section to the account signed in now: data from another account (an instance
 * that switched accounts) is hidden, and a section that names no account is attributed to the
 * current one so its own last-known limits can be restored.
 */
export function forCurrentAccount(
  account: UsageAccount,
  current: string | undefined,
): { readonly account: UsageAccount; readonly switched: boolean } {
  if (current === undefined) return { account, switched: false };
  let switched = false;
  const sections = account.sections.map((section): AccountUsageSection => {
    if (section.kind !== "provider-limits") return section;
    const owner = sectionAccount(section);
    if (owner === undefined) return { ...section, accountFingerprint: current };
    if (owner === current) return section;
    switched = true;
    return limitsSection({ accountFingerprint: current });
  });
  return { account: { ...account, sections }, switched };
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
  const identityForSnapshot = (snapshot: UsageAccount) => {
    const account = snapshot.sections.map(sectionAccount).find((value) => value !== undefined);
    return account ? antigravityAccountLimitsIdentity(account) : identity;
  };
  const currentAccount = Effect.promise(() => input.currentAccount().catch(() => undefined));
  /** Binds a snapshot to the current account and adds the quota stop observed under it. */
  const present = (
    snapshot: UsageAccount,
    options: { readonly signal: boolean },
  ): Effect.Effect<{ readonly account: UsageAccount; readonly switched: boolean }> =>
    Effect.map(currentAccount, (current) => {
      const bound = forCurrentAccount(snapshot, current);
      return {
        switched: bound.switched,
        account: options.signal
          ? withQuotaSignal(bound.account, input.quotaSignal(), now(), current)
          : bound.account,
      };
    });
  const fixed = (
    section: AccountUsageSection,
    options: { readonly signal: boolean },
  ): AccountUsageCapability => ({
    identity,
    identityForSnapshot,
    getSnapshot: Effect.map(
      present({ ...initial, sections: [section] }, options),
      (result) => result.account,
    ),
    refresh: () => Effect.void,
  });
  if (input.billedPerToken) {
    // A key's rate limit is not a subscription quota: no quota-stop notice here.
    const fetchedAt = new Date(now()).toISOString();
    return Effect.succeed(
      fixed(
        limitsSection({
          outcome: "available",
          lastAttemptAt: fetchedAt,
          snapshot: { fetchedAt, data: { windows: [], plan: "Billed per token" } },
        }),
        { signal: false },
      ),
    );
  }
  if (!input.readLimitsWithCli || !input.usageRun) {
    return Effect.succeed(
      fixed(
        limitsSection({ outcome: "unsupported", errorCode: "unsupported", readsDisabled: true }),
        { signal: true },
      ),
    );
  }
  const usageRun = input.usageRun;
  // Kept in memory first, so a refusal or verification holds even if persisting it fails.
  const refusals = new Map<string, AntigravityUsageRefusal>();
  const verified = new Set<string>();
  let lastSpawnAt = Number.NEGATIVE_INFINITY;
  const failure = (
    errorCode: AccountUsageErrorCode,
    at: string,
    account: string | undefined,
  ): ReadonlyArray<AccountUsageSection> => [
    limitsSection({
      outcome: errorCode === "unsupported" ? "unsupported" : "unavailable",
      errorCode,
      lastAttemptAt: at,
      ...(account !== undefined ? { accountFingerprint: account } : {}),
    }),
  ];
  const unsupported = (
    reason: "cli-too-old" | AntigravityUsageRefusal,
    at: string,
    account: string,
  ): ReadonlyArray<AccountUsageSection> => [
    limitsSection({
      outcome: "unsupported",
      errorCode: "unsupported",
      lastAttemptAt: at,
      unsupportedReason: reason,
      accountFingerprint: account,
    }),
  ];
  const warn = (message: string, fields: Record<string, unknown>) =>
    Effect.runPromise(Effect.logWarning(message, fields));
  const refuse = async (version: string, reason: AntigravityUsageRefusal) => {
    refusals.set(version, reason);
    await (input.refuse?.(version, reason) ?? Promise.resolve()).catch(() =>
      warn("Could not save the Antigravity /usage refusal; it holds until restart.", { reason }),
    );
  };
  const verify = async (version: string) => {
    if (verified.has(version)) return;
    verified.add(version);
    await (input.verify?.(version) ?? Promise.resolve()).catch(() => undefined);
  };
  const refusalFor = async (version: string) => {
    const remembered = refusals.get(version);
    if (remembered) return remembered;
    const stored = await input.refusal?.().catch(() => undefined);
    return stored?.version === version ? stored.reason : undefined;
  };
  const isVerified = async (version: string) =>
    verified.has(version) || (await input.verifiedVersion?.().catch(() => undefined)) === version;
  const attempt = (signal: AbortSignal, at: string) =>
    usageRun(signal, async ({ version, account, spawn }) => {
      // An install whose version can't be read is not the same as an old one.
      if (version === null) return failure("process-unavailable", at, account);
      const refusal = await refusalFor(version);
      if (refusal) return unsupported(refusal, at, account);
      if (!antigravityUsageVersionSupported(version))
        return unsupported("cli-too-old", at, account);
      const knownGood = await isVerified(version);
      lastSpawnAt = now();
      const result = await spawn();
      if (result.aborted || signal.aborted) {
        // An interrupted run proves nothing about the CLI; the next refresh may run at once.
        lastSpawnAt = Number.NEGATIVE_INFINITY;
        throw new AccountUsageReadError("temporary-failure");
      }
      const report = result.timedOut
        ? SIGNED_OUT.test(result.stderr)
          ? failed("authentication-required")
          : failed("timeout")
        : parseAntigravityUsageReport(result.stdout, result.stderr, result.code);
      if (report.kind === "failed") {
        // Until a version has answered once with a recognised report, a timeout or an
        // unrecognised answer may be a model turn in progress: stop asking that version.
        const reason: AntigravityUsageRefusal | null = report.spentTurn
          ? "cli-spends-turn"
          : !knownGood &&
              (report.errorCode === "timeout" || report.errorCode === "invalid-response")
            ? "cli-unrecognized"
            : null;
        if (reason) {
          await refuse(version, reason);
          return unsupported(reason, at, account);
        }
        return failure(report.errorCode, at, account);
      }
      await verify(version);
      const fetchedAt = new Date(now()).toISOString();
      return [
        limitsSection({
          outcome: "available",
          lastAttemptAt: fetchedAt,
          accountFingerprint: account,
          snapshot: { fetchedAt, data: { windows: report.windows, accountFingerprint: account } },
        }),
      ];
    });
  const read = Effect.tryPromise({
    try: async (signal) => {
      const at = new Date(now()).toISOString();
      try {
        return await attempt(signal, at);
      } catch (error) {
        if (signal.aborted) throw error;
        // Attributed to the account signed in now, so a failure right after a switch never
        // keeps the previous account's reading on screen.
        return failure(
          error instanceof AccountUsageReadError ? error.code : "temporary-failure",
          at,
          await input.currentAccount().catch(() => undefined),
        );
      }
    },
    catch: () => new AccountUsageReadError("temporary-failure"),
  }).pipe(
    Effect.tap((sections) => {
      const errorCode = sections.find((section) => section.errorCode !== null)?.errorCode;
      return errorCode
        ? Effect.logWarning("Antigravity /usage limits read failed.", { errorCode })
        : Effect.void;
    }),
  );
  return makeAccountUsageCapability(initial, read, {
    identity,
    readerOwnsTimeout: true,
    retryFailedReads: true,
    // Real runs only: a refusal before the CLI starts never delays the next attempt.
    notBefore: () =>
      Number.isFinite(lastSpawnAt) ? lastSpawnAt + ANTIGRAVITY_USAGE_MIN_INTERVAL_MS : null,
  }).pipe(
    Effect.map((capability): AccountUsageCapability => {
      const presentLive = (snapshot: UsageAccount) =>
        Effect.flatMap(present(snapshot, { signal: true }), ({ account, switched }) =>
          // Cached reads belong to the previous account; the next refresh runs again.
          switched && capability.invalidate
            ? Effect.as(capability.invalidate, account)
            : Effect.succeed(account),
        );
      return {
        ...capability,
        identityForSnapshot,
        getSnapshot: Effect.flatMap(capability.getSnapshot, presentLive),
        ...(capability.refreshAccount
          ? {
              refreshAccount: (permits, mode) =>
                Effect.flatMap(capability.refreshAccount!(permits, mode), (result) =>
                  Effect.map(presentLive(result.snapshot), (snapshot) => ({
                    ...result,
                    snapshot,
                  })),
                ),
            }
          : {}),
      };
    }),
  );
}
