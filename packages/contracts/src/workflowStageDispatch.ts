import { Schema } from "effect";
import { CommandId } from "./baseSchemas";

/** The durable turn-start command for the stage's current attempt. */
export const WorkflowStageDispatchCommandId = Schema.optional(Schema.NullOr(CommandId));
