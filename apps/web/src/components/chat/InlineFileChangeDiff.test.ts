import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildInlineFileChangeCheckpointDiffQueryInput } from "./InlineFileChangeDiff.logic";

describe("buildInlineFileChangeCheckpointDiffQueryInput", () => {
  it("pins inline fallback diffs to non-whitespace-ignored checkpoint options", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = TurnId.makeUnsafe("turn-1");

    expect(
      buildInlineFileChangeCheckpointDiffQueryInput({
        threadId,
        turnId,
        checkpointTurnCount: 3,
        diffUnavailable: false,
      }),
    ).toEqual({
      threadId,
      fromTurnCount: 2,
      toTurnCount: 3,
      cacheScope: `turn:${turnId}`,
      ignoreWhitespace: false,
      enabled: true,
      retryMode: "inline",
    });
  });
});
