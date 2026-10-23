import { Schema } from "effect";
import { ProjectId } from "./baseSchemas";
export const THREAD_SETTLEMENT_WS_METHODS = {
  settleProjectIdle: "threadSettlement.settleProjectIdle",
} as const;
export const SettleProjectIdleInput = Schema.Struct({ projectId: ProjectId });
