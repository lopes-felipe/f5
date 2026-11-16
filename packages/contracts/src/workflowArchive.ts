import { Schema } from "effect";
import { IsoDateTime, ThreadId } from "./baseSchemas";

/** Only threads changed by a workflow archive may be restored with it. */
export const WorkflowArchiveRestorations = Schema.optional(
  Schema.Array(Schema.Struct({ threadId: ThreadId, archivedAt: IsoDateTime })),
);
