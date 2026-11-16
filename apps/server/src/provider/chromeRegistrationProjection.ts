import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseNativeHostManifest, type ChromeNativeHostRegistration } from "./chromeNativeHost";
import {
  inspectChromeNativeHosts,
  type ChromeNativeHostLocation,
} from "./chromeNativeHostInspection";

/**
 * Isolated F5 profiles run Claude with the profile's own HOME, so the CLI writes its
 * browser registration where Chrome never looks. F5 copies those manifests, byte for byte,
 * into the real home's browser folders. The copy goes to the same locations the journal
 * snapshotted before launch, so restore and conflict detection need no change.
 */
export interface ClaudeRegistrationProjection {
  /** Where the CLI writes, under the isolated HOME. */
  readonly sources: ReadonlyArray<ChromeNativeHostLocation>;
  /** Where Chrome reads, under the real home; one per source browser. */
  readonly destinations: ReadonlyArray<ChromeNativeHostLocation>;
}

export class ChromeProjectionFailed extends Error {
  constructor(readonly reason: string) {
    super(`Claude in Chrome's registration could not be copied: ${reason}`);
  }
}

/** A destination changed owner since setup was approved: it needs fresh consent. */
export class ChromeProjectionConflict extends ChromeProjectionFailed {
  constructor(readonly location: string) {
    super(`${location} changed since setup was approved`);
  }
}

export interface ProjectionIo {
  readonly inspect: (
    locations: ReadonlyArray<ChromeNativeHostLocation>,
  ) => Promise<ReadonlyArray<ChromeNativeHostRegistration>>;
  /** null when absent. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Atomic within the destination folder: never a half-written manifest. */
  readonly writeAtomic: (path: string, bytes: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
}

export const projectionIo: ProjectionIo = {
  inspect: (locations) => inspectChromeNativeHosts(locations),
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  writeAtomic: async (path, bytes) => {
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.${basename(path)}.f5-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, "wx", 0o644);
      try {
        await file.writeFile(bytes, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const filePath = (location: ChromeNativeHostLocation) =>
  location.kind === "file" ? location.path : undefined;

/**
 * Waits for the CLI's manifests under the isolated HOME, verifies all of them and the
 * wrapper they name, then copies each to its real-home destination. Nothing is written
 * unless every source verifies; the wrapper exists before any manifest is written.
 * Returns the destinations written (unchanged ones are skipped).
 */
export async function projectClaudeRegistrations(
  input: {
    readonly projection: ClaudeRegistrationProjection;
    readonly targetPath: string;
    readonly allowedOrigins: ReadonlyArray<string>;
    readonly verifyWrapper: (bytes: string) => Promise<boolean>;
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
    readonly signal?: AbortSignal;
    /**
     * Performs the verified writes; the runtime routes them through the journal so they
     * can't race a restore. Defaults to writing each changed destination atomically.
     */
    readonly commit?: (
      writes: ReadonlyArray<{ readonly location: string; readonly bytes: string }>,
    ) => Promise<ReadonlyArray<string>>;
  },
  io: ProjectionIo = projectionIo,
): Promise<ReadonlyArray<string>> {
  const { sources, destinations } = input.projection;
  const pairs = sources.map((source) => {
    const destination = destinations.find((entry) => entry.browser === source.browser);
    const from = filePath(source);
    const to = destination && filePath(destination);
    if (!from || !to) throw new ChromeProjectionFailed(`no destination for ${source.browser}`);
    return { browser: source.browser, from, to };
  });
  if (pairs.length === 0) throw new ChromeProjectionFailed("no registrations to copy");
  const allowed = new Set(input.allowedOrigins);
  const deadline = Date.now() + (input.timeoutMs ?? 10_000);
  // The CLI writes its registration shortly after start; wait for all of it.
  let observed: ReadonlyArray<ChromeNativeHostRegistration>;
  for (;;) {
    if (input.signal?.aborted) throw new ChromeProjectionFailed("cancelled");
    observed = await io.inspect(sources);
    if (observed.every((entry) => entry.state === "ok" && entry.targetPath === input.targetPath))
      break;
    if (Date.now() >= deadline) {
      const missing = observed.find(
        (entry) => entry.state !== "ok" || entry.targetPath !== input.targetPath,
      );
      throw new ChromeProjectionFailed(
        `${missing?.browser ?? "a browser"}'s registration is ${
          missing?.state === "ok" ? "aimed elsewhere" : (missing?.state ?? "missing")
        }`,
      );
    }
    await io.sleep(input.intervalMs ?? 250);
  }
  const bytesFor = new Map<string, string>();
  for (const entry of observed) {
    if (entry.bytes === undefined) throw new ChromeProjectionFailed(`${entry.browser} is unread`);
    if (
      !entry.allowedOrigins?.length ||
      !entry.allowedOrigins.every((origin) => allowed.has(origin))
    )
      throw new ChromeProjectionFailed(`${entry.browser} allows an uncertified origin`);
    bytesFor.set(entry.browser, entry.bytes);
  }
  const wrapper = await io.readFile(input.targetPath);
  if (wrapper === null || !(await input.verifyWrapper(wrapper)))
    throw new ChromeProjectionFailed("the wrapper isn't F5's bundled Claude");
  if (input.signal?.aborted) throw new ChromeProjectionFailed("cancelled");
  const writes = pairs.map((pair) => ({ location: pair.to, bytes: bytesFor.get(pair.browser)! }));
  if (input.commit) return input.commit(writes);
  const written: string[] = [];
  for (const write of writes) {
    if (input.signal?.aborted) throw new ChromeProjectionFailed("cancelled");
    if ((await io.readFile(write.location).catch(() => null)) === write.bytes) continue;
    await io.writeAtomic(write.location, write.bytes);
    written.push(write.location);
  }
  return written;
}

/**
 * Removes the CLI's manifests under the isolated HOME before a launch, so the copy only
 * ever sees what this launch wrote. Chrome never reads these files.
 */
export async function clearProjectionSources(
  projection: ClaudeRegistrationProjection,
): Promise<void> {
  for (const source of projection.sources) {
    const path = filePath(source);
    if (path) await rm(path, { force: true });
  }
}

/**
 * Why an isolated profile's folder can't be removed yet: a Claude in Chrome setup it
 * copied into the real home still points at its wrapper, and the only record of the
 * bytes it replaced is the journal inside that folder. Restoring it in that profile's
 * Settings clears this.
 */
export async function chromeSetupBlockingRemoval(stateDir: string): Promise<string | undefined> {
  const directory = join(stateDir, "claude-chrome", "transactions");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const transaction = JSON.parse(await readFile(join(directory, name), "utf8")) as {
      state?: string;
      targetPath?: string;
      slots?: ReadonlyArray<{ kind?: string; browser?: string; location?: string }>;
    };
    if (transaction.state === "restored" || !transaction.targetPath) continue;
    for (const slot of transaction.slots ?? []) {
      if (slot.kind !== "manifest" || !slot.location || !slot.browser) continue;
      const current = parseNativeHostManifest(
        slot.browser,
        slot.location,
        await projectionIo.readFile(slot.location).catch(() => null),
      );
      if (current.state === "ok" && current.targetPath === transaction.targetPath)
        return "Claude in Chrome's browser setup still points at this profile. Restore it in this profile's Settings → Browser & Computer, then remove the profile.";
    }
  }
  return undefined;
}
