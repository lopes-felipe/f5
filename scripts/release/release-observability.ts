// @effect-diagnostics nodeBuiltinImport:off
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, writeFileSync } from "node:fs";

interface Observation {
  fields: Record<string, unknown>;
  phases: Record<string, [number, number][]>;
  retries: Record<string, number>;
}
const observations = new AsyncLocalStorage<Observation>();
export function releaseFields(fields: Record<string, unknown>): void {
  Object.assign(observations.getStore()?.fields ?? {}, fields);
}
export function releaseRetry(phase: string): void {
  const observation = observations.getStore();
  if (observation) observation.retries[phase] = (observation.retries[phase] ?? 0) + 1;
}
/** Union parallel intervals: elapsed phase time must not sum concurrent workers. */
export function intervalSeconds(intervals: readonly [number, number][]): number {
  let total = 0,
    end = -Infinity;
  for (const [start, finish] of intervals.toSorted((a, b) => a[0] - b[0])) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return Math.round(total / 1000);
}
export async function releasePhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await operation();
  } finally {
    const observation = observations.getStore();
    if (observation) (observation.phases[phase] ??= []).push([start, Date.now()]);
  }
}
export async function observeRelease(operation: () => Promise<void>): Promise<void> {
  const started = Date.now();
  const observation: Observation = { fields: { status: "reconciling" }, phases: {}, retries: {} };
  await observations.run(observation, async () => {
    try {
      await operation();
    } catch (error) {
      const status = String(observation.fields.status);
      Object.assign(observation.fields, {
        status: status.startsWith("blocked-") ? status : "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      const summary = {
        schemaVersion: 2,
        ...observation.fields,
        reconciliationSeconds: Math.round((Date.now() - started) / 1000),
        phaseSeconds: Object.fromEntries(
          Object.entries(observation.phases).map(([name, intervals]) => [
            name,
            intervalSeconds(intervals),
          ]),
        ),
        transientRetries: observation.retries,
      };
      const json = JSON.stringify(summary, null, 2) + "\n";
      writeFileSync("release-summary.json", json);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          "Release result\n\n```json\n" + json + "```\n",
        );
    }
  });
}
