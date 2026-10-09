import type {
  CompactRuntimeConfiguredActivityPayload,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { readRuntimeConfiguredPayload } from "@t3tools/shared/orchestrationActivityPayload";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** Resolve model reports by persisted event order; session configuration can precede a reroute. */
export function resolveRuntimeModelReport(input: {
  configuredRuntime: CompactRuntimeConfiguredActivityPayload | null;
  activities?: readonly OrchestrationThreadActivity[];
  rerouteActivity?: Record<string, unknown> | null;
}) {
  if (input.activities) {
    for (let index = input.activities.length - 1; index >= 0; index--) {
      const activity = input.activities[index]!;
      if (activity.kind === "runtime.model-rerouted") {
        const reroute = record(activity.payload);
        const model = text(reroute.toModel);
        if (model) return { model, reroute };
      }
      if (activity.kind === "runtime.configured") {
        const config = readRuntimeConfiguredPayload(activity.payload);
        const model = config?.runtimeInfo?.effective.model ?? config?.model;
        if (model) return { model, reroute: null };
      }
    }
  } else if (text(input.rerouteActivity?.toModel)) {
    return { model: text(input.rerouteActivity?.toModel), reroute: input.rerouteActivity! };
  }
  return {
    model: input.configuredRuntime?.runtimeInfo?.effective.model ?? input.configuredRuntime?.model,
    reroute: null,
  };
}

/** Keep headlines and details together, ordering repeated notices by their last occurrence. */
export function recentRuntimeNotices(
  activities: readonly OrchestrationThreadActivity[],
  limit = 4,
) {
  const notices = new Map<string, { id: string; title: string; details: string[] }>();
  for (const activity of activities) {
    if (
      ![
        "runtime.warning",
        "runtime.error",
        "runtime.model-rerouted",
        "config.warning",
        "deprecation.notice",
        "mcp.status.updated",
      ].includes(activity.kind)
    )
      continue;
    const payload = record(activity.payload);
    const title = activity.summary;
    const details = [
      ...new Set(
        [text(payload.message), text(payload.detail), text(payload.reason)].filter(
          (value): value is string => value !== undefined && value !== title,
        ),
      ),
    ];
    const key = JSON.stringify([activity.kind, title, details]);
    notices.delete(key);
    notices.set(key, { id: activity.id, title, details });
  }
  return [...notices.values()].slice(-limit);
}
