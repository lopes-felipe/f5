import { Effect, FileSystem, Random, Schema } from "effect";
import * as Crypto from "node:crypto";
import { ServerConfig } from "../config";

class IdentifyUserError extends Schema.TaggedErrorClass<IdentifyUserError>()("IdentifyUserError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const hash = (value: string) =>
  Effect.try({
    try: () => Crypto.createHash("sha256").update(value).digest("hex"),
    catch: (error) =>
      new IdentifyUserError({
        message: "Failed to hash identifier",
        cause: error,
      }),
  });

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;

  const anonymousId = yield* fileSystem.readFileString(serverConfig.anonymousIdPath).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const randomId = yield* Random.nextUUIDv4;
        yield* fileSystem.writeFileString(serverConfig.anonymousIdPath, randomId);
        return randomId;
      }),
    ),
  );

  return anonymousId;
});

/** Profile-local anonymous identity; account credentials are never read for telemetry. */
export const getTelemetryIdentifier = Effect.gen(function* () {
  const anonymousId = yield* Effect.result(upsertAnonymousId);
  if (anonymousId._tag === "Success") {
    return yield* hash(anonymousId.success);
  }

  return null;
}).pipe(
  Effect.tapError((error) => Effect.logWarning("Failed to get identifier", { cause: error })),
  Effect.orElseSucceed(() => null),
);
