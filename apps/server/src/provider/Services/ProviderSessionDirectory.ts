import type {
  ProjectId,
  ProviderInstanceId,
  ProviderKind,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | null;
  readonly provider: ProviderKind;
  readonly providerInstanceId?: ProviderInstanceId | null;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly mcpEffectiveConfigVersion?: string | null;
  readonly launchFingerprint?: string | null;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  readonly updateHistoryReconciliationIfCurrent: (
    input: import("../../persistence/Services/ProviderSessionRuntime.ts").ProviderHistoryReconciliationUpdate,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryWriteError>;
  readonly updateTerminalLifecycleIfCurrent: (
    input: import("../../persistence/Services/ProviderSessionRuntime.ts").ProviderTerminalLifecycleUpdate,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryWriteError>;
  readonly updateMcpStateIfCurrent: (
    input: import("../../persistence/Services/ProviderSessionRuntime.ts").ProviderMcpStateUpdate,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryWriteError>;

  readonly upsert: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Option.Option<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryReadError
  >;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  /** `excludeStopped` skips stopped rows in the query, not after decoding. */
  readonly listBindings: (options?: {
    readonly excludeStopped?: boolean;
  }) => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly listBindingsByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;
}

export class ProviderSessionDirectory extends ServiceMap.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("t3/provider/Services/ProviderSessionDirectory") {}
