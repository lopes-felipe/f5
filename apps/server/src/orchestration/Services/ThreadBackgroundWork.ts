import type { AgentsSnapshot, ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type {
  ExpireThreadBackgroundWorkInput,
  ThreadBackgroundWorkFreshnessInput,
  ThreadBackgroundWorkThreadFreshnessInput,
} from "../../persistence/Services/ThreadBackgroundWork.ts";

export interface ThreadBackgroundWorkShape {
  readonly recordProviderEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getSnapshot: Effect.Effect<AgentsSnapshot, ProjectionRepositoryError>;
  readonly expireStale: (
    input: ExpireThreadBackgroundWorkInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listProtectedThreadIds: (
    input: ThreadBackgroundWorkFreshnessInput,
  ) => Effect.Effect<ReadonlySet<ThreadId>, ProjectionRepositoryError>;
  readonly hasFreshProtectingWork: (
    input: ThreadBackgroundWorkThreadFreshnessInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly changes: Stream.Stream<ThreadId | null>;
}

export class ThreadBackgroundWork extends ServiceMap.Service<
  ThreadBackgroundWork,
  ThreadBackgroundWorkShape
>()("t3/orchestration/Services/ThreadBackgroundWork") {}
