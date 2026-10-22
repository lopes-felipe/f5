/**
 * The upstream-ports contracts that startup code needs: the settings schema,
 * RPC method and push channel names, and the push payload. Kept apart from
 * `upstreamPorts.ts` so the web app's initial bundle does not pull in the
 * ledger and RPC schemas, which only the lazy Upstream page uses.
 */
import { Schema } from "effect";

import { NonNegativeInt, ProjectId } from "./baseSchemas";
import { ModelSelection } from "./orchestration";

// ── Local-only settings ─────────────────────────────────────────────────

export const UpstreamScheduleMode = Schema.Literals(["off", "daily", "weekly"]);
export type UpstreamScheduleMode = typeof UpstreamScheduleMode.Type;

export const UpstreamSchedule = Schema.Struct({
  mode: UpstreamScheduleMode.pipe(Schema.withDecodingDefault(() => "off" as const)),
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })).pipe(
    Schema.withDecodingDefault(() => 7),
  ),
  /** 0 is Sunday; used only by the weekly mode. */
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).pipe(
    Schema.withDecodingDefault(() => 1),
  ),
});
export type UpstreamSchedule = typeof UpstreamSchedule.Type;

export const UpstreamPortsSettings = Schema.Struct({
  schedule: UpstreamSchedule.pipe(Schema.withDecodingDefault(() => ({}))),
  triageModelSelection: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(() => null)),
  portModelSelection: Schema.NullOr(ModelSelection).pipe(Schema.withDecodingDefault(() => null)),
});
export type UpstreamPortsSettings = typeof UpstreamPortsSettings.Type;

// ── RPC names and push payload ──────────────────────────────────────────

export const UPSTREAM_PORTS_WS_METHODS = {
  listProjects: "upstreamPorts.listProjects",
  getOverview: "upstreamPorts.getOverview",
  listTopics: "upstreamPorts.listTopics",
  getTopic: "upstreamPorts.getTopic",
  decide: "upstreamPorts.decide",
  acceptSuggestions: "upstreamPorts.acceptSuggestions",
  run: "upstreamPorts.run",
  startPort: "upstreamPorts.startPort",
  unlinkPort: "upstreamPorts.unlinkPort",
  getPortPrompt: "upstreamPorts.getPortPrompt",
  resolvePublication: "upstreamPorts.resolvePublication",
  addRemote: "upstreamPorts.addRemote",
  takeOverWriter: "upstreamPorts.takeOverWriter",
} as const;

export const UPSTREAM_PORTS_WS_CHANNELS = {
  changed: "upstreamPorts.changed",
} as const;

export const UpstreamChangedReason = Schema.Literals([
  "run-started",
  "run-finished",
  "ledger-updated",
  "ports-updated",
  "publication-updated",
]);
export type UpstreamChangedReason = typeof UpstreamChangedReason.Type;

export const UpstreamPortsChanged = Schema.Struct({
  projectId: ProjectId,
  reason: UpstreamChangedReason,
  newInboxCount: Schema.optionalKey(NonNegativeInt),
});
export type UpstreamPortsChanged = typeof UpstreamPortsChanged.Type;
