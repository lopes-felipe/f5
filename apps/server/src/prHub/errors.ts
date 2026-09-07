import { Effect } from "effect";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
export const prHubActionError = (detail: string) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "prHub.action",
    detail,
    kind: "forbidden",
  });

export const prHubPersistenceError = (operation: string, cause: unknown) =>
  new SourceControlProviderError({
    provider: "github",
    operation,
    detail: "Could not persist PR Hub state.",
    kind: "generic",
    cause,
  });

export const persistPrHubState =
  (operation: string) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("failed to persist PR Hub state", {
          operation,
          cause: String(error),
        }),
      ),
      Effect.mapError((error) => prHubPersistenceError(operation, error)),
    );
