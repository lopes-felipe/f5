import { Effect, Schema, ServiceMap } from "effect";

export type PreparationPhase =
  | "allocated"
  | "checkout_created"
  | "setup_running"
  | "setup_failed"
  | "setup_indeterminate"
  | "completed"
  | "skipped";
export interface PreparationAllocation {
  readonly operationId: string;
  readonly repositoryIdentity: string;
  readonly projectIdentity: string;
  readonly owner: string;
  readonly requestedBase: string;
  /** Null only while an explicit name is reserved before the background fetch. */
  readonly baseOid: string | null;
  readonly path: string;
  readonly branch: string;
  readonly namingIntent: "explicit" | "generated" | "temporary" | "existing";
  readonly setupIdentity: string | null;
  readonly runSetupScript: boolean;
}
export interface WorktreePreparationReceipt extends PreparationAllocation {
  readonly createdCheckout: boolean;
  readonly phase: PreparationPhase;
  readonly version: number;
  readonly error: string | null;
  readonly result: string | null;
}
export class PreparationError extends Schema.TaggedErrorClass<PreparationError>()(
  "PreparationError",
  {
    message: Schema.String,
    operationId: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    recoveryRequired: Schema.optional(Schema.Boolean),
  },
) {}
export interface WorktreePreparationsShape {
  readonly unfinished: Effect.Effect<ReadonlyArray<WorktreePreparationReceipt>, PreparationError>;
  readonly allocate: (
    input: PreparationAllocation,
  ) => Effect.Effect<WorktreePreparationReceipt, PreparationError>;
  readonly latest: (
    path: string,
  ) => Effect.Effect<WorktreePreparationReceipt | null, PreparationError>;
  readonly update: (
    receipt: WorktreePreparationReceipt,
    patch: {
      setupIdentity?: string | null;
      createdCheckout?: boolean;
      phase?: PreparationPhase;
      branch?: string;
      error?: string | null;
      result?: string | null;
    },
  ) => Effect.Effect<WorktreePreparationReceipt, PreparationError>;
  readonly branchReserved: (
    repository: string,
    branch: string,
  ) => Effect.Effect<boolean, PreparationError>;
  readonly reconcile: Effect.Effect<void, PreparationError>;
}
export class WorktreePreparations extends ServiceMap.Service<
  WorktreePreparations,
  WorktreePreparationsShape
>()("t3/persistence/Services/WorktreePreparations") {}
export const needsPreparation = (receipt: WorktreePreparationReceipt | null) =>
  receipt !== null &&
  ["checkout_created", "setup_failed", "setup_indeterminate"].includes(receipt.phase);
