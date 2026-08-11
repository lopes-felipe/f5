import { ensureProviderTurnDeliveriesSchema } from "./ProviderTurnDeliveriesSchema.ts";

// Migration 58 changed during development after some databases had already
// recorded it. Repair those databases here instead of assuming its table exists.
export default ensureProviderTurnDeliveriesSchema;
