import { RewindDraftState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  describePendingRevert,
  describeRewindDraft,
  isRewindInFlight,
  withoutSettledRewindFailures,
} from "./rewindDraftCopy";

describe("describeRewindDraft", () => {
  it("never shows a raw state name", () => {
    for (const state of RewindDraftState.literals) {
      for (const error of [null, "boom"]) {
        const copy = describeRewindDraft({ state, error });
        expect(copy.title).not.toContain(state);
        expect(copy.title.length).toBeGreaterThan(0);
      }
    }
  });

  it("only spins while the server is actually working", () => {
    expect(isRewindInFlight({ state: "prepared", error: null })).toBe(true);
    expect(isRewindInFlight({ state: "prepared", error: "Timed out" })).toBe(false);
    expect(isRewindInFlight({ state: "provider-pending" })).toBe(true);
    expect(isRewindInFlight({ state: "reconciliation-required" })).toBe(false);
    expect(isRewindInFlight({ state: "completed" })).toBe(false);
  });

  it("offers the safe actions for each failure", () => {
    expect(describeRewindDraft({ state: "prepared", error: "Timed out" })).toMatchObject({
      title: "Revert didn't finish",
      actions: ["cancel", "retry"],
    });
    expect(describeRewindDraft({ state: "reconciliation-required" }).actions).toEqual(["recheck"]);
    expect(describeRewindDraft({ state: "completed" }).actions).toEqual(["discard", "edit"]);
  });
});

describe("describePendingRevert", () => {
  it("names the step the revert is on", () => {
    expect(describePendingRevert({ restoreFiles: false })).toBe("Reverting conversation…");
    expect(describePendingRevert({ restoreFiles: true })).toBe("Reverting conversation and files…");
    expect(
      describePendingRevert({
        restoreFiles: false,
        state: "provider-pending",
        providerLabel: "Codex",
      }),
    ).toBe("Waiting for Codex to confirm…");
    expect(describePendingRevert({ restoreFiles: true, state: "provider-confirmed" })).toBe(
      "Restoring files…",
    );
  });
});

describe("withoutSettledRewindFailures", () => {
  const failure = (operationId?: string) => ({
    kind: "conversation.rewind.failed",
    payload: operationId ? { detail: "x", operationId } : { detail: "x" },
  });
  const other = { kind: "tool.started", payload: {} };

  it("keeps failures of open rewinds and drops settled or legacy ones", () => {
    const activities = [other, failure("open"), failure("settled"), failure()];
    expect(withoutSettledRewindFailures(activities, new Set(["open"]))).toEqual([
      other,
      failure("open"),
    ]);
  });

  it("returns the same array when nothing is dropped", () => {
    const activities = [other, failure("open")];
    expect(withoutSettledRewindFailures(activities, new Set(["open"]))).toBe(activities);
  });
});
