import { describe, expect, it } from "vitest";
import { openCodeTodoPlan } from "./openCodeTodos";

describe("OpenCode native checklists", () => {
  it("projects progress, removes cancelled tasks, and supports clears", () => {
    expect(
      openCodeTodoPlan([
        { content: " Inspect ", status: "completed" },
        { content: "Build", status: "in_progress" },
        { content: "Verify", status: "pending" },
        { content: "Dropped", status: "cancelled" },
      ]),
    ).toEqual([
      { step: "Inspect", status: "completed" },
      { step: "Build", status: "inProgress" },
      { step: "Verify", status: "pending" },
    ]);
    expect(openCodeTodoPlan([])).toEqual([]);
    expect(openCodeTodoPlan([{ content: "Dropped", status: "cancelled" }])).toEqual([]);
  });
  it.each([undefined, {}, [{ content: "Unknown", status: "new" }], [{ status: "pending" }]])(
    "does not clear the checklist for an unrecognized result (%j)",
    (value) => {
      expect(openCodeTodoPlan(value)).toBeUndefined();
    },
  );
});
