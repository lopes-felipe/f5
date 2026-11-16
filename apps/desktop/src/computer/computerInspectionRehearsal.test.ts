import { expect, it } from "vitest";
import {
  computerFixturePerformanceArgs,
  computerInspectionRehearsalRequest,
  computerInspectionDigest,
  computerInspectionSampleObservation,
} from "./computerInspectionRehearsal";
import type { ComputerAuthorization, ComputerInspectResult } from "@t3tools/contracts";

it("reports the scenario and completeness failure instead of accepting a faster invalid sample", () => {
  const reference: ComputerInspectResult = {
    appId: "fixture",
    snapshotId: "snapshot",
    accessible: true,
    nodes: [
      {
        elementRef: "button",
        role: "button",
        name: "fixture",
        focused: false,
        enabled: true,
        actions: ["press"],
      },
    ],
  };
  const digest = computerInspectionDigest(reference);
  expect(computerInspectionSampleObservation("inspect.large.400", reference, digest)).toMatchObject(
    {
      passed: true,
      actual: 0,
    },
  );
  for (const [tree, reason] of [
    [{ ...reference, truncated: true }, "truncated"],
    [{ ...reference, accessible: false }, "inaccessible"],
    [{ ...reference, nodes: [] }, "empty"],
    [{ ...reference, nodes: [{ ...reference.nodes[0]!, name: "changed" }] }, "content-changed"],
  ] as const) {
    const observation = computerInspectionSampleObservation("inspect.large.400", tree, digest);
    expect(observation).toEqual({
      name: "inspect.large.400." + reason,
      actual: 1,
      maximum: 0,
      passed: false,
    });
    expect(JSON.stringify(observation)).not.toContain("fixture");
    expect(JSON.stringify(observation)).not.toContain('"name":"changed"');
  }
});

it("uses the same background delivery and inspection shape for reference and measured samples", () => {
  const authorization = {} as ComputerAuthorization;
  const reference = computerInspectionRehearsalRequest("fixture", 400, authorization);
  const measured = computerInspectionRehearsalRequest("fixture", 400, authorization);
  const { requestId: _a, deadlineAtMs: _b, ...referenceShape } = reference;
  const { requestId: _c, deadlineAtMs: _d, ...measuredShape } = measured;
  expect(referenceShape).toEqual(measuredShape);
  expect(referenceShape).toMatchObject({ delivery: "background", maxNodes: 400 });
});
it("forwards deterministic tree and delayed-input fixture modes", () => {
  expect(computerFixturePerformanceArgs({ treeNodes: 380, delayedFocus: true })).toEqual([
    "--tree-nodes",
    "380",
    "--delayed-focus",
  ]);
  expect(computerFixturePerformanceArgs({})).toEqual([]);
  for (const treeNodes of [0, 801, 1.5, NaN])
    expect(() => computerFixturePerformanceArgs({ treeNodes })).toThrow();
});
