import { ensureNextTurnQueueSchema } from "./NextTurnQueueSchema.ts";

// Migration 57 changed during development after some databases had already
// recorded it. Repair those databases from a new migration that will still run.
export default ensureNextTurnQueueSchema;
