import { Schema } from "effect";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { GitCommandError } from "../git/Errors.ts";

/**
 * CheckpointUnavailableError - Expected checkpoint does not exist.
 */
export class CheckpointUnavailableError extends Schema.TaggedErrorClass<CheckpointUnavailableError>()(
  "CheckpointUnavailableError",
  {
    threadId: Schema.String,
    turnCount: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: ${this.detail}`;
  }
}

/**
 * CheckpointInvariantError - Inconsistent provider/filesystem/catalog state.
 */
export class CheckpointInvariantError extends Schema.TaggedErrorClass<CheckpointInvariantError>()(
  "CheckpointInvariantError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: ${this.detail}`;
  }
}

/**
 * CheckpointUnsupportedError - The workspace cannot hold checkpoints, such as a
 * folder its parent repository ignores with no tracked files inside.
 */
export class CheckpointUnsupportedError extends Schema.TaggedErrorClass<CheckpointUnsupportedError>()(
  "CheckpointUnsupportedError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Checkpoints are unsupported in ${this.cwd}: ${this.detail}`;
  }
}

export type CheckpointStoreError =
  | GitCommandError
  | CheckpointInvariantError
  | CheckpointUnavailableError
  | CheckpointUnsupportedError;

export type CheckpointServiceError = CheckpointStoreError | ProjectionRepositoryError;
