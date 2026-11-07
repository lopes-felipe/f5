import { createHash } from "node:crypto";
import { measure, type PerformanceReport } from "./report.ts";

export const COMPUTER_PERFORMANCE_TEXT = "F5_PERFORMANCE_INPUT";
export interface ComputerPerformanceDriver {
  app: string;
  text: string;
  prepare(
    size: "small" | "large",
    mode?: "delayed" | "changing" | "coordinates" | "delayed-focus",
  ): Promise<void>;
  call(tool: string, args: Record<string, unknown>): Promise<Record<string, any>>;
  verify(): Promise<{ presses: number; expectedText: boolean; entered: boolean }>;
  overlay(animated: boolean): Promise<void>;
  resetCalls(): void;
  calls(): number;
  inspection?(name: string, value: Tree): void;
}
type Tree = {
  snapshotId: string;
  truncated?: boolean;
  accessible: boolean;
  nodes: Array<Record<string, any>>;
};
/** Fixed harness assertions are safe to report; provider errors are excluded. */
export class ComputerPerformanceError extends Error {}
/** A cold conditional wait resolves its fixture once; polling must reuse the result. */
export function verifyComputerResolutionCount(count: number): void {
  if (count !== 1)
    throw new ComputerPerformanceError("Conditional wait must resolve its app exactly once.");
}
function tree(value: Record<string, any>): Tree {
  if (!value.accessible || value.truncated || !value.nodes?.length)
    throw new ComputerPerformanceError("Inspection must be complete, accessible and nonempty.");
  return value as Tree;
}
function node(value: Tree, name: string) {
  const found = value.nodes.find((entry) => entry.name === name);
  if (!found) throw new ComputerPerformanceError("Required synthetic fixture node is missing.");
  return found;
}
async function press(
  driver: ComputerPerformanceDriver,
  snapshot: Tree,
  name: string,
  inspect = false,
) {
  return driver.call("computer_element_action", {
    app: driver.app,
    snapshotId: snapshot.snapshotId,
    elementRef: node(snapshot, name).ref,
    action: "press",
    screenshot: false,
    inspect,
  });
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ComputerPerformanceError(message);
}
export function computerPerformanceScenarios(driver: ComputerPerformanceDriver) {
  const inspect = async () =>
    tree(await driver.call("computer_inspect", { app: driver.app, maxNodes: 400 }));
  const effects = async (presses: number, text = false, entered = false) => {
    const deadline = performance.now() + 1000;
    for (;;) {
      const actual = await driver.verify();
      if (
        actual.presses === presses &&
        (!text || actual.expectedText) &&
        (!entered || actual.entered)
      )
        return;
      assert(actual.presses <= presses, "Synthetic press counter exceeded the expected effect.");
      if (performance.now() >= deadline)
        throw new ComputerPerformanceError("Synthetic effects did not verify.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  let prepared: Tree | undefined;
  const scenarios: Array<{
    name: string;
    size: "small" | "large";
    mode?: "delayed" | "changing" | "coordinates" | "delayed-focus";
    prepare?: () => Promise<void>;
    run: () => Promise<void>;
    calls?: number;
  }> = [
    ...(["small", "large"] as const).map((size) => ({
      name: "inspect." + size,
      size,
      calls: 1,
      run: async () => {
        const value = await inspect();
        if (size === "large")
          assert(value.nodes.length >= 350, "Large tree is unexpectedly small.");
        driver.inspection?.("inspect." + size, value);
      },
    })),
    ...(["early", "late"] as const).map((position) => ({
      name: "resolution." + position,
      size: "large" as const,
      calls: 1,
      prepare: async () => {
        prepared = await inspect();
      },
      run: async () => {
        await press(
          driver,
          prepared!,
          position === "early" ? "Fixture node 0" : "Fixture node 379",
        );
        await effects(1);
      },
    })),
    {
      name: "task.accessibility",
      size: "small",
      calls: 3,
      run: async () => {
        const snapshot = await inspect();
        const updated = await driver.call("computer_element_action", {
          app: driver.app,
          snapshotId: snapshot.snapshotId,
          elementRef: node(snapshot, "Rehearsal input").ref,
          action: "setValue",
          value: driver.text,
          inspect: true,
          screenshot: false,
        });
        await press(driver, tree(updated.inspect), "Rehearsal press", true);
        await effects(1, true);
      },
    },
    {
      name: "task.coordinates",
      size: "small",
      mode: "coordinates",
      calls: 2,
      prepare: async () => {
        prepared = await inspect();
        await driver.call("computer_screenshot", {});
      },
      run: async () => {
        const target = node(prepared!, "Rehearsal press");
        const [x, y, width, height] = target.b as number[];
        for (let count = 0; count < 2; count++)
          await driver.call("computer_click", {
            x: Math.floor(x! + width! / 2),
            y: Math.floor(y! + height! / 2),
            displayId: target.d ?? (prepared as any).displayId,
            screenshot: true,
          });
        await effects(2);
      },
    },
    {
      name: "task.conditional-wait",
      size: "small",
      mode: "delayed",
      calls: 2,
      run: async () => {
        const waited = await driver.call("computer_wait", {
          app: driver.app,
          name: "Delayed ready",
          timeoutMs: 5000,
          inspect: true,
        });
        assert(waited.matched === true, "Delayed control was not detected.");
        await press(driver, tree(waited.inspect), "Delayed ready", true);
        await effects(1);
      },
    },
    ...(["static", "changing"] as const).map((mode) => ({
      name: "wait." + mode,
      size: "small" as const,
      ...(mode === "changing" ? { mode } : {}),
      calls: 1,
      run: async () => {
        const waited = await driver.call("computer_wait", {
          app: driver.app,
          timeoutMs: 2500,
          inspect: true,
        });
        assert(waited.settled === true && !waited.timedOut, "Tree did not settle.");
        tree(waited.inspect);
      },
    })),
    {
      name: "task.foreground-no-capture",
      size: "small",
      calls: 2,
      run: async () => {
        await driver.call("computer_type", {
          app: driver.app,
          text: driver.text,
          screenshot: false,
        });
        await driver.call("computer_key", { app: driver.app, keys: "Enter", screenshot: false });
        await effects(0, true, true);
      },
    },
    ...([false, true] as const).map((batch) => ({
      name: batch ? "task.batch" : "task.unbatched",
      size: "small" as const,
      mode: "delayed-focus" as const,
      calls: batch ? 2 : 4,
      run: async () => {
        const snapshot = await inspect();
        const focus = {
          snapshotId: snapshot.snapshotId,
          elementRef: node(snapshot, "Rehearsal input").ref,
          action: "focus",
        };
        if (batch) {
          const value = await driver.call("computer_batch", {
            app: driver.app,
            steps: [
              { op: "element_action", ...focus },
              { op: "type", text: driver.text },
              { op: "key", keys: "Enter" },
            ],
            inspect: true,
          });
          assert(
            value.stepsCompleted === 3 && !value.stopped,
            "Batch stopped before completing its effects.",
          );
          tree(value.inspect);
        } else {
          const value = await driver.call("computer_element_action", {
            app: driver.app,
            ...focus,
            screenshot: false,
          });
          // Legacy helpers lack read-back; independent text and Enter receipts still verify effects.
          assert(value.verification?.verified !== false, "Focus did not verify.");
          await driver.call("computer_type", {
            app: driver.app,
            text: driver.text,
            screenshot: false,
          });
          const after = await driver.call("computer_key", {
            app: driver.app,
            keys: "Enter",
            screenshot: false,
            inspect: true,
          });
          tree(after.inspect);
        }
        await effects(0, true, true);
      },
    })),
    ...([false, true] as const).map((animated) => ({
      name: animated ? "overlay.animated" : "overlay.non-animated",
      size: "small" as const,
      run: () => driver.overlay(animated),
    })),
  ];
  return scenarios;
}
export async function measureComputerTasks(
  driver: ComputerPerformanceDriver,
  method = { warmups: 5, repetitions: 30 },
) {
  const measurements: PerformanceReport["measurements"] = {};
  const observations: PerformanceReport["observations"] = [];
  for (const scenario of computerPerformanceScenarios(driver)) {
    try {
      measurements[scenario.name] = await measure(
        async () => {
          await scenario.run();
          if (scenario.calls !== undefined)
            assert(
              driver.calls() === scenario.calls,
              "Timed MCP call count differs from the scenario.",
            );
        },
        method,
        async () => {
          await driver.prepare(scenario.size, scenario.mode);
          await scenario.prepare?.();
          driver.resetCalls();
        },
      );
      observations.push({ name: scenario.name + ".failures", actual: 0, maximum: 0, passed: true });
    } catch (cause) {
      observations.push({
        name: scenario.name + ".failures",
        actual: 1,
        maximum: 0,
        passed: false,
      });
      const reason =
        cause instanceof ComputerPerformanceError ? cause.message : "native-or-driver-error";
      observations.push({
        name: scenario.name + ".reason." + reason,
        actual: 1,
        maximum: 0,
        passed: false,
      });
      // Never average failures away or continue input after an ambiguous native effect.
      break;
    }
  }
  return { measurements, observations };
}
export function normalizedComputerTreeDigest(value: Tree): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accessible: value.accessible,
        truncated: value.truncated ?? false,
        nodes: value.nodes.map(({ ref: _ref, ...entry }) => entry),
      }),
    )
    .digest("hex");
}
