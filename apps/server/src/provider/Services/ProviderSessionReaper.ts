import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

import type { ProviderSessionDirectoryPersistenceError } from "../Errors.ts";

export interface ProviderSessionReaperShape {
  readonly sweep: () => Effect.Effect<void, ProviderSessionDirectoryPersistenceError>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderSessionReaper extends ServiceMap.Service<
  ProviderSessionReaper,
  ProviderSessionReaperShape
>()("t3/provider/Services/ProviderSessionReaper") {}
