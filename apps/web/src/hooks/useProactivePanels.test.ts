import { TurnId } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { proactiveDiffAction } from "./useProactivePanels";

const turn = TurnId.makeUnsafe("turn");
const base = {
  previousTurnId: turn,
  runningTurnId: null,
  completedTurnId: turn,
  checkpoint: { status: "ready", files: [{ path: "a.ts" }] },
  isRepo: true,
};

it("defers until the completed checkpoint and repository are available", () => {
  expect(proactiveDiffAction({ ...base, checkpoint: undefined })).toBe("defer");
  expect(proactiveDiffAction({ ...base, isRepo: undefined })).toBe("defer");
  expect(proactiveDiffAction(base)).toBe("open");
});

it("ignores interrupted turns, mismatched completions, empty and failed diffs", () => {
  expect(proactiveDiffAction({ ...base, completedTurnId: null })).toBe("ignore");
  expect(proactiveDiffAction({ ...base, previousTurnId: TurnId.makeUnsafe("other") })).toBe(
    "ignore",
  );
  expect(proactiveDiffAction({ ...base, runningTurnId: turn })).toBe("ignore");
  expect(proactiveDiffAction({ ...base, checkpoint: { files: [], status: "ready" } })).toBe(
    "ignore",
  );
  expect(
    proactiveDiffAction({ ...base, checkpoint: { ...base.checkpoint, status: "error" } }),
  ).toBe("ignore");
});
