import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { Effect, FileSystem, Path, type ServiceMap } from "effect";
import type {
  ChromeLeaseHolder,
  ChromeNativeHostRestoreResult,
  ChromeNativeHostTransactionSummary,
} from "@t3tools/contracts";
import {
  PROVIDER_INTEGRATION_RECORDS,
  certifiedIntegrationRecord,
  integrationRecordById,
  type ClaudeChromeRecord,
} from "@t3tools/shared/providerIntegrationCertification";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import {
  CLAUDE_IN_CHROME_HOME_MISMATCH,
  CLAUDE_IN_CHROME_ISOLATED_PROFILE,
  CLAUDE_IN_CHROME_NEEDS_BUNDLED,
  claudeInChromeUnavailableDetail,
} from "./Layers/claudeAgentBrowser";
import { claudeChromeDescriptor, parseShellToken, type ChromeProvider } from "./chromeNativeHost";
import { inspectChromeNativeHosts } from "./chromeNativeHostInspection";
import {
  ChromeNativeHostTransactions,
  ChromeRestoreBlocked,
  isStaleTransaction,
  restoreBlocker,
  type ChromeArtifactSlot,
  type ChromeNativeHostTransaction,
} from "./chromeNativeHostJournal";
import {
  makeChromeNativeHostStorage,
  readChromeArtifact,
  type PersistentChromeNativeHostStorage,
} from "./chromeNativeHostStorage";
import { chromeRuntimeHost, type ChromeSessionRuntime } from "./chromeSessionRuntime";

const runtimes = new Map<string, ChromeSessionRuntime>();
const threadRuntimes = new Map<string, { runtime: ChromeSessionRuntime; generation: string }>();

export type ChromeUnavailableReason = {
  reason:
    | "not-certified"
    | "platform"
    | "custom-binary"
    | "executable-drift"
    | "home-mismatch"
    | "isolated-profile"
    | "unverifiable";
  detail: string;
};

export interface ClaudeChromeIdentity {
  readonly record: ClaudeChromeRecord;
  readonly executableRealpath: string;
  /** Metadata identity only: the 240 MB executable is never hashed. */
  readonly fingerprint: string;
}

/**
 * Executable identity without hashing: the resolved executable must be F5's bundled
 * Claude by realpath, its platform package version must equal the record's SDK
 * version, and the provider must run with the real macOS home.
 */
export async function claudeChromeAvailability(input: {
  readonly platform?: string;
  readonly arch?: string;
  readonly executablePath: string | undefined;
  readonly resolveDefaultExecutable: () => string;
  readonly userHome: string;
  readonly systemHome?: string;
  /** The provider runs with the profile's own HOME (`F5_PROFILE_ISOLATED=1`). */
  readonly isolatedProfile?: boolean;
  readonly records?: ReadonlyArray<ClaudeChromeRecord>;
}): Promise<ClaudeChromeIdentity | { unavailable: ChromeUnavailableReason }> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const record = certifiedIntegrationRecord(
    "claude-chrome",
    platform,
    arch,
    input.records ?? PROVIDER_INTEGRATION_RECORDS["claude-chrome"],
  );
  if (!record)
    return {
      unavailable: {
        reason: platform === "darwin" ? "not-certified" : "platform",
        detail: claudeInChromeUnavailableDetail(platform, arch),
      },
    };
  // The CLI registers its browser connection under HOME, and Chrome reads only the real
  // home; an isolated profile deliberately keeps its own HOME, so this cannot work there.
  if (input.isolatedProfile)
    return {
      unavailable: { reason: "isolated-profile", detail: CLAUDE_IN_CHROME_ISOLATED_PROFILE },
    };
  if ((input.systemHome ?? userInfo().homedir) !== input.userHome)
    return { unavailable: { reason: "home-mismatch", detail: CLAUDE_IN_CHROME_HOME_MISMATCH } };
  try {
    const bundled = await realpath(input.resolveDefaultExecutable());
    const resolved = await realpath(input.executablePath ?? bundled);
    if (resolved !== bundled)
      return { unavailable: { reason: "custom-binary", detail: CLAUDE_IN_CHROME_NEEDS_BUNDLED } };
    const manifest = JSON.parse(await readFile(join(dirname(bundled), "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (
      manifest.name !== record.identity.platformPackage ||
      manifest.version !== record.versions.sdkVersion
    )
      return {
        unavailable: {
          reason: "executable-drift",
          detail: "This Claude build isn't certified for Chrome. Update F5.",
        },
      };
    const info = await stat(bundled);
    return {
      record,
      executableRealpath: bundled,
      fingerprint: `${bundled}\0${info.ino}\0${info.size}\0${info.mtimeMs}`,
    };
  } catch {
    return {
      unavailable: { reason: "unverifiable", detail: "F5 couldn't verify its bundled Claude." },
    };
  }
}

export function registerChromeSession(
  threadId: string,
  generation: string,
  runtime: ChromeSessionRuntime,
): void {
  threadRuntimes.set(threadId, { runtime, generation });
}
/** Idempotent: safe from every finalizer path. */
export async function releaseChromeSession(threadId: string, generation: string): Promise<void> {
  const entry = threadRuntimes.get(threadId);
  if (entry?.generation !== generation) return;
  threadRuntimes.delete(threadId);
  await entry.runtime.finalize(threadId, generation);
}
export function chromeSessionFingerprint(threadId: string, enabled: boolean): string {
  return JSON.stringify({
    enabled,
    runtime: threadRuntimes.get(threadId)?.runtime.fingerprint(threadId),
  });
}
export function isChromeRuntimeSession(threadId: string): boolean {
  return threadRuntimes.has(threadId);
}

const storages = new Map<string, Promise<PersistentChromeNativeHostStorage>>();
/** One storage per state dir: journal writes for the profile share one queue. */
function storageFor(
  stateDir: string,
  services: ServiceMap.ServiceMap<FileSystem.FileSystem | Path.Path>,
  inspect?: PersistentChromeNativeHostStorage["inspect"],
): Promise<PersistentChromeNativeHostStorage> {
  const make = () =>
    Effect.runPromise(
      makeChromeNativeHostStorage({ stateDir, inspect: inspect ?? (async () => []) }).pipe(
        Effect.provide(services),
      ),
    );
  // Runtime storages carry their descriptor's inspection; storage-only ones are shared.
  if (inspect) return make();
  const existing = storages.get(stateDir);
  if (existing) return existing;
  const created = make();
  storages.set(stateDir, created);
  return created;
}

export const makeChromeSessionRuntime = (input: {
  stateDir: string;
  providerHome: string;
  userHome: string;
  isolatedProfile?: boolean;
  executablePath: string | undefined;
  resolveDefaultExecutable: () => string;
  broker: ComputerAutomationBrokerRuntime;
  policyEnabled: (threadId: string) => Promise<boolean>;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
    const identity = yield* Effect.promise(() =>
      claudeChromeAvailability({
        executablePath: input.executablePath,
        resolveDefaultExecutable: input.resolveDefaultExecutable,
        userHome: input.userHome,
        ...(input.isolatedProfile ? { isolatedProfile: true } : {}),
      }),
    );
    if ("unavailable" in identity) return identity;
    const key = JSON.stringify([
      input.stateDir,
      "claude",
      input.providerHome,
      identity.fingerprint,
    ]);
    const existing = runtimes.get(key);
    if (existing) return { runtime: existing };
    const descriptor = claudeChromeDescriptor(identity.record);
    const locations = descriptor.locations(input.providerHome, input.userHome);
    const storage = yield* Effect.promise(() =>
      storageFor(input.stateDir, services, () => inspectChromeNativeHosts(locations)),
    );
    const runtime = chromeRuntimeHost({
      broker: input.broker,
      descriptor,
      record: identity.record,
      storage,
      userHome: input.userHome,
      executableRealpath: identity.executableRealpath,
      policyEnabled: input.policyEnabled,
    });
    runtimes.set(key, runtime);
    return { runtime };
  });

/** Retained historical rules, keyed by the transaction's record; never executes a wrapper. */
async function validateSlot(
  transaction: ChromeNativeHostTransaction,
  slot: ChromeArtifactSlot,
): Promise<boolean> {
  const record = (
    transaction.legacy
      ? PROVIDER_INTEGRATION_RECORDS["claude-chrome"].find((entry) =>
          entry.browsers.some((browser) => browser.id === slot.browser),
        )
      : integrationRecordById(transaction.recordId)
  ) as ClaudeChromeRecord | undefined;
  if (!record || record.integration !== "claude-chrome") return false;
  const userHome = transaction.legacy ? userInfo().homedir : transaction.userHome;
  let expected: string | undefined;
  let root: string;
  if (slot.kind === "manifest") {
    const browser = record.browsers.find((entry) => entry.id === slot.browser);
    if (!browser) return false;
    expected = join(userHome, ...browser.nativeMessagingPath, `${record.identity.hostName}.json`);
    root = userHome;
  } else {
    if (transaction.legacy || !transaction.providerHome) return false;
    expected = join(transaction.providerHome, ...record.identity.wrapperPath);
    root = transaction.providerHome;
  }
  if (slot.location !== expected) return false;
  try {
    const canonicalRoot = await realpath(root);
    const parent = await realpath(dirname(slot.location)).catch(() => undefined);
    if (parent !== undefined && parent !== canonicalRoot && !parent.startsWith(canonicalRoot + sep))
      return false;
    const info = await lstat(slot.location).catch(() => undefined);
    return !info || info.isFile();
  } catch {
    return false;
  }
}

async function summarize(
  transaction: ChromeNativeHostTransaction,
  all: ReadonlyArray<ChromeNativeHostTransaction>,
): Promise<ChromeNativeHostTransactionSummary> {
  const wrapper = transaction.slots.find((slot) => slot.kind === "wrapper");
  let wrapperBytes: string | null | undefined;
  let targetExists: boolean | undefined;
  if (wrapper && transaction.state !== "restored") {
    wrapperBytes = await readChromeArtifact(wrapper.location).then(
      (read) => read.bytes,
      () => undefined,
    );
    const execLine = wrapperBytes?.split("\n").find((line) => line.startsWith("exec "));
    const token = execLine?.slice(5).split(" --")[0];
    const command = token ? parseShellToken(token) : undefined;
    if (command)
      targetExists = await stat(command).then(
        () => true,
        () => false,
      );
  }
  const blockedBy = restoreBlocker(transaction, all);
  const unresolved = transaction.slots
    .filter((slot) => slot.outcome === "unresolved" || slot.outcome === "skipped")
    .map((slot) => slot.location);
  return {
    id: transaction.id,
    provider: transaction.provider,
    targetPath: transaction.targetPath,
    createdAt: transaction.createdAt,
    state: transaction.state,
    ...(isStaleTransaction(transaction, wrapperBytes, targetExists) ? { stale: true } : {}),
    ...(transaction.legacy ? { legacy: true } : {}),
    ...(blockedBy ? { blockedBy } : {}),
    ...(unresolved.length ? { unresolved } : {}),
  };
}

/** Reads storage directly: history survives restarts, SDK upgrades and retired records. */
export const listChromeSessionSetups = (stateDir: string, provider: ChromeProvider) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
    return yield* Effect.promise(async () => {
      const storage = await storageFor(stateDir, services);
      const all = await storage.listTransactions(provider);
      return Promise.all(
        [...all]
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((transaction) => summarize(transaction, all)),
      );
    });
  });

export class ChromeRestoreBusy extends Error {
  constructor() {
    super("Stop browser/computer control in the other F5 profile, then retry.");
    this.name = "ChromeRestoreBusy";
  }
}

/** Main refused the restore lease for a reason other than another holder. */
export class ChromeRestoreUnavailable extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof ComputerControlError && cause.error._tag === "Execution"
        ? cause.error.message
        : "F5 couldn't take browser ownership for the restore. Try again in a moment.",
    );
    this.name = "ChromeRestoreUnavailable";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Storage-only restore. Stops the profile's Chrome sessions and takes the main-owned
 * lease first; another profile holding it returns `busy` within 5 s with nothing written.
 */
export const restoreChromeSessionSetup = (input: {
  stateDir: string;
  provider: ChromeProvider;
  transactionId: string;
  stopSessions: () => Promise<void>;
  broker: ComputerAutomationBrokerRuntime | undefined;
}) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
    return yield* Effect.promise(async (): Promise<ChromeNativeHostRestoreResult> => {
      const storage = await storageFor(input.stateDir, services);
      const transaction = await storage.loadTransaction(input.provider, input.transactionId);
      if (!transaction) throw new Error("Chrome transaction does not belong to this profile.");
      if (input.broker && transaction.profileId !== input.broker.host.profileId)
        throw new Error("Chrome transaction does not belong to this profile.");
      const holder: ChromeLeaseHolder | undefined = input.broker
        ? {
            profileId: input.broker.host.profileId,
            threadId: randomUUID(),
            sessionGeneration: randomUUID(),
            provider: input.provider,
          }
        : undefined;
      let acquired = false;
      const acquire = async () => {
        if (!input.broker || !holder) return;
        const deadline = Date.now() + 5_000;
        for (;;) {
          try {
            await input.broker.host.correlated(
              { type: "chromeRestoreAcquire", requestId: randomUUID(), holder },
              5_000,
              false,
            );
            acquired = true;
            return;
          } catch (error) {
            // Same-profile sessions release only after main observes their CLI exit.
            const busy = error instanceof ComputerControlError && error.error._tag === "Busy";
            if (!busy) throw new ChromeRestoreUnavailable(error);
            if (Date.now() >= deadline) throw new ChromeRestoreBusy();
            await sleep(250);
          }
        }
      };
      try {
        const result = await new ChromeNativeHostTransactions(storage).restore(transaction, {
          stopSessions: async () => {
            await input.stopSessions();
            await acquire();
          },
          validateSlot,
        });
        return {
          restored: result.restored,
          skipped: result.skipped,
          unresolved: result.unresolved,
          state: result.transaction.state,
        };
      } catch (error) {
        if (error instanceof ChromeRestoreBlocked)
          return {
            restored: [],
            skipped: [],
            blockingTransactionId: error.blockingTransactionId,
          };
        if (error instanceof ChromeRestoreBusy) return { restored: [], skipped: [], busy: true };
        if (error instanceof ChromeRestoreUnavailable)
          return { restored: [], skipped: [], failure: error.message.slice(0, 500) };
        throw error;
      } finally {
        if (acquired && holder && input.broker)
          input.broker.host.send({ type: "chromeLeaseRelease", requestId: randomUUID(), holder });
      }
    });
  });

/** At server start: settle every non-restored transaction (crash and timeout recovery). */
export const reconcileChromeSessionSetups = (stateDir: string) =>
  Effect.gen(function* () {
    const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
    yield* Effect.promise(async () => {
      const storage = await storageFor(stateDir, services);
      const transactions = new ChromeNativeHostTransactions(storage);
      for (const transaction of await storage.listTransactions("claude").catch(() => []))
        if (transaction.state !== "restored")
          await transactions.reconcile(transaction).catch(() => undefined);
    });
  });
