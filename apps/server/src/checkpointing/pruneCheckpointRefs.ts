import { Effect } from "effect";
import type { CheckpointStoreShape } from "./Services/CheckpointStore.ts";

/** Removing stale refs must not prevent completion of an already applied rollback. */
export function pruneCheckpointRefs(
  store: CheckpointStoreShape,
  input: Parameters<CheckpointStoreShape["deleteCheckpointRefs"]>[0],
) {
  return store
    .deleteCheckpointRefs(input)
    .pipe(
      Effect.catch((error) => Effect.logWarning("Could not remove stale checkpoint refs", error)),
    );
}
