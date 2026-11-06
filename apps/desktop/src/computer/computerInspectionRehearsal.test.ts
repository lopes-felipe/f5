import { expect, it } from "vitest";
import {
  computerFixturePerformanceArgs,
  computerInspectionRehearsalRequest,
} from "./computerInspectionRehearsal";
import type { ComputerAuthorization } from "@t3tools/contracts";

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
