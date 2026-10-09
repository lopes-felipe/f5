import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { Effect, FileSystem, Path } from "effect";
import { writeFileStringAtomically } from "../atomicWrite";
import type { ComputerAutomationBrokerRuntime } from "../computer/ComputerAutomationBroker";
import {
  CHROME_NATIVE_HOST_CERTIFICATIONS,
  parseChromeRegistryQuery,
  type ChromeProvider,
} from "./chromeNativeHost";
import { inspectChromeNativeHosts } from "./chromeNativeHostInspection";
import { makeChromeNativeHostStorage } from "./chromeNativeHostStorage";
import { chromeRuntimeHost, type ChromeSessionRuntime } from "./chromeSessionRuntime";

const runtimes = new Map<
  string,
  { stateDir: string; provider: ChromeProvider; runtime: ChromeSessionRuntime }
>();
const threadRuntimes = new Map<string, { runtime: ChromeSessionRuntime; generation: string }>();
const exec = promisify(execFile);
export async function listChromeSessionSetups(stateDir: string, provider: ChromeProvider) {
  const entries = await Promise.all(
    [...runtimes.values()]
      .filter((entry) => entry.stateDir === stateDir && entry.provider === provider)
      .map((entry) => entry.runtime.listTransactions()),
  );
  return [...new Map(entries.flat().map((entry) => [entry.id, entry])).values()];
}

export function registerChromeSession(
  threadId: string,
  generation: string,
  runtime: ChromeSessionRuntime,
): void {
  threadRuntimes.set(threadId, { runtime, generation });
}
export function releaseChromeSession(threadId: string, generation: string): void {
  const entry = threadRuntimes.get(threadId);
  if (entry?.generation !== generation) return;
  entry.runtime.release(threadId, generation);
  threadRuntimes.delete(threadId);
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
export async function restoreChromeSessionSetup(
  stateDir: string,
  provider: ChromeProvider,
  transactionId: string,
  stopSessions: () => Promise<void>,
) {
  const candidates = [...runtimes.values()].filter(
    (entry) => entry.stateDir === stateDir && entry.provider === provider,
  );
  if (!candidates.length)
    throw new Error("No certified Chrome runtime is available for this profile.");
  for (const entry of candidates) {
    const result = await entry.runtime.restore(transactionId, stopSessions).catch((error) => {
      if (
        error instanceof Error &&
        error.message === "Chrome transaction does not belong to this profile."
      )
        return undefined;
      throw error;
    });
    if (result) return result;
  }
  throw new Error("Chrome transaction does not belong to this profile.");
}

export const makeChromeSessionRuntime = (input: {
  stateDir: string;
  providerHome: string;
  executablePath: string | undefined;
  resolveDefaultExecutable?: () => string;
  broker: ComputerAutomationBrokerRuntime;
  provider: ChromeProvider;
}) =>
  Effect.gen(function* () {
    const records = CHROME_NATIVE_HOST_CERTIFICATIONS.flatMap((descriptor) =>
      descriptor.runtime && descriptor.verifyServer ? [{ descriptor, ...descriptor.runtime }] : [],
    ).filter(
      (entry) =>
        entry.platform === process.platform &&
        entry.descriptor.provider === input.provider &&
        entry.descriptor.certified &&
        entry.evidence,
    );
    if (!records.length) return undefined;
    const executable = yield* Effect.tryPromise(async () => {
      const executablePath = input.executablePath ?? input.resolveDefaultExecutable?.();
      if (!executablePath) return undefined;
      const size = (await stat(executablePath)).size;
      if (size > 512 * 1024 * 1024)
        throw new Error("Chrome launch executable is too large to verify.");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(executablePath)) hash.update(chunk);
      return hash.digest("hex");
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const record = records.find((entry) => entry.executableSha256 === executable);
    if (!record) return undefined;
    const key = JSON.stringify([input.stateDir, input.provider, input.providerHome, executable]);
    const existing = runtimes.get(key);
    if (existing) return existing.runtime;
    const locations = record.locations(input.providerHome, homedir());
    const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
    const storage = yield* makeChromeNativeHostStorage({
      stateDir: input.stateDir,
      inspect: () => inspectChromeNativeHosts(locations),
      restoreRegistration: async (location, bytes) => {
        const slot = locations.find((entry) =>
          entry.kind === "file"
            ? entry.path === location
            : `${entry.view}:${entry.key}` === location,
        );
        if (!slot) throw new Error("Native-host restoration location is not certified.");
        if (slot.kind === "registry") {
          if (process.platform !== "win32" || !/^(HKCU|HKLM)\\[^\r\n]+$/i.test(slot.key))
            throw new Error("Uncertified registry restoration.");
          if (bytes === null) {
            await exec("reg", ["delete", slot.key, "/f", `/reg:${slot.view}`], {
              windowsHide: true,
              timeout: 10000,
            });
          } else {
            const original = JSON.parse(bytes) as {
              registry?: unknown;
              manifestPath?: unknown;
              manifestBytes?: unknown;
            };
            if (
              typeof original.registry !== "string" ||
              typeof original.manifestPath !== "string" ||
              !win32.isAbsolute(original.manifestPath) ||
              typeof original.manifestBytes !== "string" ||
              parseChromeRegistryQuery(original.registry) !== original.manifestPath
            )
              throw new Error("Invalid original native-host registry snapshot.");
            await Effect.runPromise(
              writeFileStringAtomically({
                filePath: original.manifestPath,
                contents: original.manifestBytes,
              }).pipe(Effect.provide(services)),
            );
            await exec(
              "reg",
              [
                "add",
                slot.key,
                "/ve",
                "/t",
                "REG_SZ",
                "/d",
                original.manifestPath,
                "/f",
                `/reg:${slot.view}`,
              ],
              { windowsHide: true, timeout: 10000 },
            );
          }
          return;
        }
        if (bytes === null) {
          const { unlink } = await import("node:fs/promises");
          await unlink(slot.path).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        } else
          await Effect.runPromise(
            writeFileStringAtomically({ filePath: slot.path, contents: bytes }).pipe(
              Effect.provide(services),
            ),
          );
      },
    });
    const runtime = chromeRuntimeHost({
      broker: input.broker,
      descriptor: record.descriptor,
      storage,
    });
    runtimes.set(key, { stateDir: input.stateDir, provider: input.provider, runtime });
    return runtime;
  });
