import { expect, it } from "vitest";
import {
  measureComputerTasks,
  normalizedComputerTreeDigest,
  type ComputerPerformanceDriver,
} from "./computerTasks.ts";

function fixtureDriver() {
  let calls = 0,
    presses = 0,
    value = "",
    entered = false,
    size = "small";
  const commands: Array<{ op: string; args: Record<string, any> }> = [];
  const inspect = () => ({
    snapshotId: "fixture",
    accessible: true,
    displayId: "1",
    nodes: [
      ...Array.from({ length: size === "large" ? 380 : 0 }, (_, index) => ({
        name: "Fixture node " + index,
        role: "AXButton",
        ref: "edge" + index,
        actions: ["press"],
      })),
      {
        name: "Rehearsal input",
        role: "AXTextField",
        ref: "input",
        value,
        actions: ["focus", "setValue"],
      },
      {
        name: "Rehearsal press",
        role: "AXButton",
        ref: "press",
        actions: ["press"],
        b: [10, 10, 10, 10],
      },
      { name: "Delayed ready", role: "AXButton", ref: "delayed", actions: ["press"] },
    ],
  });
  const driver: ComputerPerformanceDriver = {
    app: "fixture",
    text: "synthetic",
    prepare: async (next) => {
      size = next;
      presses = 0;
      value = "";
      entered = false;
    },
    resetCalls: () => {
      calls = 0;
    },
    calls: () => calls,
    verify: async () => ({ presses, expectedText: value === driver.text, entered }),
    overlay: async () => {},
    call: async (op, args) => {
      calls++;
      commands.push({ op, args });
      if (op === "computer_inspect") return inspect();
      if (op === "computer_wait") return { settled: true, matched: true, inspect: inspect() };
      if (op === "computer_click") presses++;
      if (op === "computer_element_action" && args.action === "press") presses++;
      if (op === "computer_element_action" && args.action === "setValue")
        value = args.value as string;
      if (op === "computer_type") value = args.text as string;
      if (op === "computer_key") entered = value === driver.text;
      if (op === "computer_batch") {
        value = driver.text;
        entered = true;
      }
      return {
        actionCompleted: true,
        verification: { verified: true },
        stepsCompleted: op === "computer_batch" ? 3 : undefined,
        ...(args.inspect ? { inspect: inspect() } : {}),
      };
    },
  };
  return { driver, commands };
}
it("measures all scenarios with verified effects and the specified MCP call counts", async () => {
  const { driver, commands } = fixtureDriver();
  const result = await measureComputerTasks(driver, { warmups: 0, repetitions: 1 });
  expect(Object.keys(result.measurements)).toHaveLength(14);
  expect(result.observations.every((value) => value.passed)).toBe(true);
  expect(result.measurements["task.batch"]?.wallMs).toHaveLength(1);
  expect(commands.filter((entry) => entry.op === "computer_batch")).toHaveLength(1);
  const accessibility = commands.find(
    (entry) => entry.op === "computer_element_action" && entry.args.action === "setValue",
  );
  expect(accessibility?.args).toMatchObject({ inspect: true, screenshot: false });
});
it("keeps warmups outside reported samples", async () => {
  const { driver } = fixtureDriver();
  const result = await measureComputerTasks(driver, { warmups: 2, repetitions: 3 });
  expect(Object.values(result.measurements).every((value) => value.wallMs.length === 3)).toBe(true);
});
it("records a verified-effect failure and stops before sending any later input", async () => {
  const { driver, commands } = fixtureDriver();
  driver.verify = async () => ({ presses: 99, expectedText: false, entered: false });
  const result = await measureComputerTasks(driver, { warmups: 0, repetitions: 1 });
  expect(result.observations.at(-1)).toMatchObject({
    name: "resolution.early.failures",
    passed: false,
  });
  expect(result.measurements["resolution.early"]).toBeUndefined();
  expect(commands.some((entry) => entry.op === "computer_type")).toBe(false);
});
it("includes completeness, actions and values in inspection equivalence", () => {
  const original = {
    snapshotId: "one",
    accessible: true,
    nodes: [{ ref: "one", role: "AXTextField", value: "x", actions: ["setValue"] }],
  };
  const digest = normalizedComputerTreeDigest(original);
  expect(
    normalizedComputerTreeDigest({
      ...original,
      snapshotId: "two",
      nodes: [{ ...original.nodes[0], ref: "two" }],
    }),
  ).toBe(digest);
  expect(normalizedComputerTreeDigest({ ...original, truncated: true })).not.toBe(digest);
  expect(
    normalizedComputerTreeDigest({ ...original, nodes: [{ ...original.nodes[0], value: "y" }] }),
  ).not.toBe(digest);
});
