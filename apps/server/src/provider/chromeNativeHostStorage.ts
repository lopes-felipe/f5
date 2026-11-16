import { constants as fsConstants } from "node:fs";
import { chmod, lstat, open, unlink } from "node:fs/promises";
import { Effect, FileSystem, Path, Schema } from "effect";
import { writeFileStringAtomically } from "../atomicWrite";
import type { ChromeNativeHostRegistration, ChromeProvider } from "./chromeNativeHost";
import type {
  ChromeArtifactRead,
  ChromeJournalStorage,
  ChromeNativeHostTransaction,
} from "./chromeNativeHostJournal";

const Id = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const Provider = Schema.Literals(["claude", "codex"]);
const Slot = Schema.Struct({
  kind: Schema.Literals(["manifest", "wrapper"]),
  browser: Schema.String,
  location: Schema.String,
  originalBytes: Schema.NullOr(Schema.String),
  originalHash: Schema.NullOr(Schema.String),
  originalMode: Schema.optionalKey(Schema.Number),
  predecessor: Schema.optionalKey(Schema.String),
  postLaunchHash: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.Literals(["restoring", "restored", "skipped", "unresolved"])),
  intent: Schema.optionalKey(
    Schema.Struct({
      expectedHash: Schema.NullOr(Schema.String),
      desiredHash: Schema.NullOr(Schema.String),
    }),
  ),
});
const SnapshotEntry = Schema.Struct({
  browser: Schema.String,
  location: Schema.String,
  state: Schema.Literals(["absent", "ok", "unreadable", "malformed"]),
  sha256: Schema.optionalKey(Schema.String),
  targetPath: Schema.optionalKey(Schema.String),
  allowedOrigins: Schema.optionalKey(Schema.Array(Schema.String)),
  shadowed: Schema.optionalKey(Schema.Boolean),
  hostName: Schema.optionalKey(Schema.String),
});
const TransactionV2 = Schema.Struct({
  version: Schema.Literal(2),
  id: Id,
  provider: Provider,
  profileId: Schema.String,
  providerInstanceId: Schema.String,
  recordId: Schema.String,
  evidenceId: Schema.optionalKey(Schema.String),
  sdkVersion: Schema.optionalKey(Schema.String),
  executablePath: Schema.optionalKey(Schema.String),
  providerHome: Schema.String,
  userHome: Schema.String,
  targetPath: Schema.String,
  createdAt: Schema.String,
  state: Schema.Literals([
    "approved",
    "launched",
    "restoring",
    "partially-restored",
    "restored",
    "recovery-required",
  ]),
  launchVerified: Schema.optionalKey(Schema.Boolean),
  launchSnapshot: Schema.optionalKey(Schema.Array(SnapshotEntry)),
  acceptedForeign: Schema.Array(Schema.Struct({ location: Schema.String, sha256: Schema.String })),
  slots: Schema.Array(Slot),
  legacy: Schema.optionalKey(Schema.Boolean),
});
/** v1 journals: manifest slots only, no record, provider home or wrapper slot. */
const TransactionV1 = Schema.Struct({
  id: Id,
  provider: Provider,
  profileId: Schema.String,
  targetPath: Schema.String,
  createdAt: Schema.String,
  state: Schema.Literals(["approved", "launched", "restored"]),
  registrations: Schema.Array(
    Schema.Struct({
      browser: Schema.String,
      location: Schema.String,
      originalBytes: Schema.NullOr(Schema.String),
      originalHash: Schema.NullOr(Schema.String),
      postLaunchHash: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeV2 = Schema.decodeUnknownSync(TransactionV2);
const decodeV1 = Schema.decodeUnknownSync(TransactionV1);

/** Legacy journals are read conservatively; `legacy` keeps unprovable slots unresolved. */
export function decodeChromeTransaction(raw: unknown): ChromeNativeHostTransaction {
  if (typeof raw === "object" && raw !== null && (raw as { version?: unknown }).version === 2)
    return decodeV2(raw) as ChromeNativeHostTransaction;
  const legacy = decodeV1(raw);
  return {
    version: 2,
    id: legacy.id,
    provider: legacy.provider,
    profileId: legacy.profileId,
    providerInstanceId: "",
    recordId: "",
    providerHome: "",
    userHome: "",
    targetPath: legacy.targetPath,
    createdAt: legacy.createdAt,
    state: legacy.state,
    acceptedForeign: [],
    legacy: true,
    slots: legacy.registrations.map((entry) => ({
      kind: "manifest" as const,
      browser: entry.browser,
      location: entry.location,
      originalBytes: entry.originalBytes,
      originalHash: entry.originalHash,
      ...(entry.postLaunchHash ? { postLaunchHash: entry.postLaunchHash } : {}),
    })),
  };
}

const MAX_ARTIFACT_BYTES = 1024 * 1024;
/** Reads a regular file (never through a symlink). null means positively absent. */
export async function readChromeArtifact(location: string): Promise<ChromeArtifactRead> {
  let info;
  try {
    info = await lstat(location);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null };
    throw error;
  }
  if (!info.isFile()) throw new Error("Chrome artifact is not a regular file.");
  // No-follow open and a check on the opened descriptor: a symlink swapped in after
  // `lstat` is refused rather than read.
  const file = await open(location, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ELOOP") throw new Error("Chrome artifact is not a regular file.");
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!file) return { bytes: null };
  try {
    const opened = await file.stat();
    if (!opened.isFile()) throw new Error("Chrome artifact is not a regular file.");
    const buffer = Buffer.alloc(MAX_ARTIFACT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ARTIFACT_BYTES) throw new Error("Chrome artifact exceeds the size limit.");
    return { bytes: buffer.subarray(0, bytesRead).toString("utf8"), mode: opened.mode & 0o777 };
  } finally {
    await file.close();
  }
}

export interface PersistentChromeNativeHostStorage extends ChromeJournalStorage {}

/** No settings, HTTP, or renderer API can create an accepted transaction. Certified
 * provider flows supply inspection; constructing storage writes nothing. */
export const makeChromeNativeHostStorage = (input: {
  readonly stateDir: string;
  readonly inspect: () => Promise<ReadonlyArray<ChromeNativeHostRegistration>>;
  readonly readArtifact?: (location: string) => Promise<ChromeArtifactRead>;
  readonly writeArtifact?: (location: string, bytes: string | null, mode?: number) => Promise<void>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
    const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      Effect.runPromise(effect.pipe(Effect.provide(services)));
    const directory = (provider: ChromeProvider) => {
      if (provider !== "claude" && provider !== "codex")
        throw new Error("Unknown Chrome provider.");
      return path.join(input.stateDir, `${provider}-chrome`, "transactions");
    };
    const transactionPath = (provider: ChromeProvider, id: string) => {
      Schema.decodeUnknownSync(Id)(id);
      return path.join(directory(provider), `${id}.json`);
    };
    let writes: Promise<unknown> = Promise.resolve();
    const serialize = <A>(task: () => Promise<A>): Promise<A> => {
      const result = writes.then(task);
      writes = result.catch(() => undefined);
      return result;
    };
    const loadTransaction = async (provider: ChromeProvider, id: string) => {
      const file = transactionPath(provider, id);
      if (!(await run(fs.exists(file)))) return undefined;
      const info = await run(fs.stat(file));
      if (Number(info.size) > 4 * 1024 * 1024)
        throw new Error("Chrome transaction exceeds the size limit.");
      const transaction = decodeChromeTransaction(JSON.parse(await run(fs.readFileString(file))));
      if (transaction.provider !== provider || transaction.id !== id)
        throw new Error("Chrome transaction identity mismatch.");
      return transaction;
    };
    const storage: PersistentChromeNativeHostStorage = {
      // Runtime and storage-only instances for one state dir share one journal queue.
      lockKey: path.resolve(input.stateDir),
      inspect: input.inspect,
      readArtifact: input.readArtifact ?? readChromeArtifact,
      writeArtifact:
        input.writeArtifact ??
        (async (location, bytes, mode) => {
          if (bytes === null) {
            await unlink(location).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
            return;
          }
          await run(writeFileStringAtomically({ filePath: location, contents: bytes }));
          if (mode !== undefined) await chmod(location, mode);
        }),
      saveTransaction: (raw) =>
        serialize(async () => {
          const transaction = decodeV2(raw) as ChromeNativeHostTransaction;
          const contents = JSON.stringify(transaction);
          if (Buffer.byteLength(contents) > 4 * 1024 * 1024)
            throw new Error("Chrome transaction exceeds the size limit.");
          await run(
            writeFileStringAtomically({
              filePath: transactionPath(transaction.provider, transaction.id),
              contents,
            }),
          );
        }),
      loadTransaction,
      listTransactions: async (provider) => {
        const dir = directory(provider);
        if (!(await run(fs.exists(dir)))) return [];
        const names = await run(fs.readDirectory(dir));
        const transactions: ChromeNativeHostTransaction[] = [];
        for (const name of names) {
          if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
          const transaction = await loadTransaction(provider, name.slice(0, -5));
          if (transaction) transactions.push(transaction);
        }
        return transactions;
      },
    };
    return storage;
  });
