import { createHash, randomUUID } from "node:crypto";
import type { ChromeNativeHostLocation } from "./chromeNativeHostInspection";

export type ChromeProvider = "claude" | "codex";
export interface ChromeNativeHostDescriptor {
  readonly provider: ChromeProvider;
  readonly hostNames: ReadonlyArray<string>;
  readonly browsers: ReadonlyArray<string>;
  readonly certified: boolean;
  readonly expectedTarget: (providerHome: string) => string;
  readonly verifyServer?: (status: unknown) => boolean;
  readonly runtime?: {
    readonly platform: "darwin" | "win32";
    readonly executableSha256: string;
    readonly evidence: string;
    readonly locations: (
      providerHome: string,
      userHome: string,
    ) => ReadonlyArray<ChromeNativeHostLocation>;
  };
}
/** Names and targets must come from recorded CLI/plugin certification, never guesses. */
export const CHROME_NATIVE_HOST_CERTIFICATIONS: ReadonlyArray<ChromeNativeHostDescriptor> = [];
export interface ChromeNativeHostRegistration {
  readonly browser: string;
  readonly location: string;
  readonly state: "absent" | "ok" | "unreadable" | "malformed";
  readonly bytes?: string;
  readonly sha256?: string;
  readonly targetPath?: string;
  readonly shadowed?: boolean;
  readonly hostName?: string;
}
export type ChromeLaunchDecision =
  | { readonly kind: "off" | "unknown"; readonly detail?: string }
  | { readonly kind: "launch"; readonly targetPath: string }
  | {
      readonly kind: "needs-consent";
      readonly targetPath: string;
      readonly previousTargets: ReadonlyArray<string>;
    };
export function chromeLaunchDecision(input: {
  enabled: boolean;
  descriptor: ChromeNativeHostDescriptor;
  providerHome: string;
  registrations: ReadonlyArray<ChromeNativeHostRegistration>;
  managedTargets: ReadonlySet<string>;
  accepted?: ChromeNativeHostTransaction;
}): ChromeLaunchDecision {
  if (!input.enabled || !input.descriptor.certified) return { kind: "off" };
  const bad = input.registrations.find(
    (entry) => entry.state === "unreadable" || entry.state === "malformed",
  );
  if (bad) return { kind: "unknown", detail: `Chrome setup unreadable: ${bad.location}` };
  const targetPath = input.descriptor.expectedTarget(input.providerHome);
  const foreign = input.registrations.filter(
    (entry) =>
      !entry.shadowed &&
      entry.state === "ok" &&
      entry.targetPath !== targetPath &&
      !input.managedTargets.has(entry.targetPath ?? ""),
  );
  const accepted =
    input.accepted?.targetPath === targetPath &&
    input.accepted.state !== "restored" &&
    foreign.every((entry) =>
      input.accepted!.registrations.some(
        (original) =>
          original.location === entry.location && original.originalHash === entry.sha256,
      ),
    );
  return !foreign.length || accepted
    ? { kind: "launch", targetPath }
    : {
        kind: "needs-consent",
        targetPath,
        previousTargets: [...new Set(foreign.map((entry) => entry.targetPath!))],
      };
}
export function parseNativeHostManifest(
  browser: string,
  location: string,
  bytes: string | null,
): ChromeNativeHostRegistration {
  if (bytes === null) return { browser, location, state: "absent" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const value = JSON.parse(bytes) as {
      path?: unknown;
      name?: unknown;
      type?: unknown;
      allowed_origins?: unknown;
    };
    if (
      typeof value.path !== "string" ||
      !value.path ||
      typeof value.name !== "string" ||
      value.type !== "stdio" ||
      !Array.isArray(value.allowed_origins)
    )
      return { browser, location, state: "malformed", sha256 };
    return { browser, location, state: "ok", bytes, sha256, targetPath: value.path };
  } catch {
    return { browser, location, state: "malformed", sha256 };
  }
}
/** Parses reg query's default manifest path without assuming one registry view. */
export function parseChromeRegistryQuery(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => /^\s*(?:\(Default\)|<NO NAME>)\s+REG_SZ\s+/i.test(entry));
  return line?.replace(/^\s*(?:\(Default\)|<NO NAME>)\s+REG_SZ\s+/i, "").trim() || null;
}
export function effectiveChromeRegistrations(
  entries: ReadonlyArray<ChromeNativeHostRegistration>,
): ReadonlyArray<ChromeNativeHostRegistration> {
  const seen = new Set<string>();
  // Caller supplies Chrome lookup order: user before machine, each certified view.
  return entries.map((entry) => {
    const identity = `${entry.browser}\0${entry.hostName ?? ""}`;
    const shadowed = seen.has(identity);
    if (entry.state !== "absent") seen.add(identity);
    return { ...entry, shadowed };
  });
}
export interface ChromeNativeHostTransaction {
  readonly id: string;
  readonly provider: ChromeProvider;
  readonly profileId: string;
  readonly targetPath: string;
  readonly createdAt: string;
  readonly state: "approved" | "launched" | "restored";
  readonly registrations: ReadonlyArray<{
    readonly browser: string;
    readonly location: string;
    readonly originalBytes: string | null;
    readonly originalHash: string | null;
    readonly postLaunchHash?: string;
  }>;
}
export interface ChromeNativeHostStorage {
  readonly inspect: () => Promise<ReadonlyArray<ChromeNativeHostRegistration>>;
  readonly saveTransaction: (transaction: ChromeNativeHostTransaction) => Promise<void>;
  /** null restores an originally absent entry; implemented only by certified descriptors. */
  readonly restoreRegistration: (location: string, bytes: string | null) => Promise<void>;
}
/** All transaction and restoration writes run behind one semaphore. */
export class ChromeNativeHostTransactions {
  private work: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: ChromeNativeHostStorage) {}
  private serialize<A>(task: () => Promise<A>): Promise<A> {
    const result = this.work.then(task);
    this.work = result.catch(() => undefined);
    return result;
  }
  approve(input: {
    provider: ChromeProvider;
    profileId: string;
    targetPath: string;
    observed: ReadonlyArray<ChromeNativeHostRegistration>;
  }): Promise<ChromeNativeHostTransaction> {
    return this.serialize(async () => {
      const current = await this.storage.inspect();
      if (
        JSON.stringify(current.map((entry) => [entry.location, entry.sha256, entry.state])) !==
        JSON.stringify(input.observed.map((entry) => [entry.location, entry.sha256, entry.state]))
      )
        throw new Error("Chrome setup changed; fresh consent is required.");
      if (current.some((entry) => entry.state === "unreadable" || entry.state === "malformed"))
        throw new Error("Chrome setup unreadable.");
      const transaction: ChromeNativeHostTransaction = {
        id: randomUUID(),
        provider: input.provider,
        profileId: input.profileId,
        targetPath: input.targetPath,
        createdAt: new Date().toISOString(),
        state: "approved",
        registrations: current.map((entry) => ({
          browser: entry.browser,
          location: entry.location,
          originalBytes: entry.bytes ?? null,
          originalHash: entry.sha256 ?? null,
        })),
      };
      await this.storage.saveTransaction(transaction);
      return transaction;
    });
  }
  recordLaunch(transaction: ChromeNativeHostTransaction): Promise<ChromeNativeHostTransaction> {
    return this.serialize(async () => {
      const current = await this.storage.inspect();
      const invalid = current.some(
        (entry) =>
          entry.state !== "absent" &&
          (entry.state !== "ok" ||
            (!entry.shadowed && entry.targetPath !== transaction.targetPath)),
      );
      const next: ChromeNativeHostTransaction = {
        ...transaction,
        state: "launched",
        registrations: transaction.registrations.map((entry) => {
          const after = current.find((registration) => registration.location === entry.location);
          return {
            ...entry,
            ...(after?.state === "ok" &&
            after.targetPath === transaction.targetPath &&
            after.sha256 &&
            after.sha256 !== entry.originalHash
              ? { postLaunchHash: after.sha256 }
              : {}),
          };
        }),
      };
      await this.storage.saveTransaction(next);
      if (invalid) throw new Error("Chrome registration does not match the approved target.");
      return next;
    });
  }
  restore(
    transaction: ChromeNativeHostTransaction,
    stopSessions: () => Promise<void>,
  ): Promise<{
    transaction: ChromeNativeHostTransaction;
    restored: ReadonlyArray<string>;
    skipped: ReadonlyArray<string>;
  }> {
    return this.serialize(async () => {
      await stopSessions();
      const current = await this.storage.inspect();
      const restored: string[] = [],
        skipped: string[] = [];
      for (const entry of transaction.registrations) {
        const after = current.find((registration) => registration.location === entry.location);
        if (!entry.postLaunchHash || after?.sha256 !== entry.postLaunchHash) {
          skipped.push(entry.location);
          continue;
        }
        await this.storage.restoreRegistration(entry.location, entry.originalBytes);
        restored.push(entry.location);
      }
      const next: ChromeNativeHostTransaction = { ...transaction, state: "restored" };
      await this.storage.saveTransaction(next);
      return { transaction: next, restored, skipped };
    });
  }
}
