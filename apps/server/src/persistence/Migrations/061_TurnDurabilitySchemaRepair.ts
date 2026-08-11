import * as Effect from "effect/Effect";

import { ensureAttachmentSchema } from "./AttachmentSchema.ts";
import { ensureProjectionTurnsProcessingQuiescedColumn } from "./ProjectionTurnsSchema.ts";

export default Effect.gen(function* () {
  yield* ensureProjectionTurnsProcessingQuiescedColumn;
  yield* ensureAttachmentSchema;
});
