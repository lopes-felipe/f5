import { Effect, FileSystem, Path, Schema } from "effect";
import { writeFileStringAtomically } from "../atomicWrite";
import type {
  ChromeNativeHostRegistration,
  ChromeNativeHostStorage,
  ChromeNativeHostTransaction,
  ChromeProvider,
} from "./chromeNativeHost";

const Transaction = Schema.Struct({
  id: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  ),
  provider: Schema.Literals(["claude", "codex"]),
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
export interface PersistentChromeNativeHostStorage extends ChromeNativeHostStorage {
  readonly loadTransaction: (
    provider: ChromeProvider,
    id: string,
  ) => Promise<ChromeNativeHostTransaction | undefined>;
  readonly listTransactions: (
    provider: ChromeProvider,
  ) => Promise<ReadonlyArray<ChromeNativeHostTransaction>>;
}
/** No settings, HTTP, or renderer API can create an accepted transaction. Certified
 * provider flows supply inspection and restoration; constructing storage writes nothing. */
export const makeChromeNativeHostStorage = (input: {
  readonly stateDir: string;
  readonly inspect: () => Promise<ReadonlyArray<ChromeNativeHostRegistration>>;
  readonly restoreRegistration: (location: string, bytes: string | null) => Promise<void>;
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
      Schema.decodeUnknownSync(Transaction.fields.id)(id);
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
      const transaction = Schema.decodeUnknownSync(Transaction)(
        JSON.parse(await run(fs.readFileString(file))),
      );
      if (transaction.provider !== provider || transaction.id !== id)
        throw new Error("Chrome transaction identity mismatch.");
      return transaction;
    };
    const storage: PersistentChromeNativeHostStorage = {
      inspect: input.inspect,
      restoreRegistration: input.restoreRegistration,
      saveTransaction: (raw) =>
        serialize(async () => {
          const transaction = Schema.decodeUnknownSync(Transaction)(raw);
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
