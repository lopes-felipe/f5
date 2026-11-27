import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  MAX_READ_ONLY_REFUSAL_FOLLOW_UPS,
  promptWithReadOnlyRefusalFollowUps,
  readOnlyRefusalFailureText,
  readOnlyRefusalFollowUpText,
  type ReadOnlyRefusalState,
} from "./AcpReadOnlyRefusalFollowUp.ts";

const REFUSAL = "touch marker (`touch` is not on the read-only allowlist)";

/** Runs the loop against a scripted agent: each prompt ends with the next scripted state. */
function run(script: ReadonlyArray<ReadOnlyRefusalState & { readonly stop?: string }>) {
  const sent: string[][] = [];
  let state: ReadOnlyRefusalState = { refusals: [], repliedSinceRefusal: false };
  const exit = Effect.runSyncExit(
    promptWithReadOnlyRefusalFollowUps<string, { readonly stop: string }, string>({
      first: ["review the change"],
      send: (parts) =>
        Effect.sync(() => {
          const step = script[sent.length]!;
          sent.push([...parts]);
          state = step;
          return { stop: step.stop ?? "end_turn" };
        }),
      followUp: (text) => [text],
      endedTurn: (result) => result.stop === "end_turn",
      settle: Effect.void,
      take: () => {
        const taken = state;
        state = { refusals: [], repliedSinceRefusal: false };
        return taken;
      },
      fail: (refusal) => readOnlyRefusalFailureText("Antigravity", refusal),
    }),
  );
  return { sent, exit };
}

describe("promptWithReadOnlyRefusalFollowUps", () => {
  it("sends nothing more when the turn ends without a refusal", () => {
    const { sent, exit } = run([{ refusals: [], repliedSinceRefusal: false }]);
    expect(sent).toEqual([["review the change"]]);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("sends nothing more when the agent replied after the refusal", () => {
    const { sent } = run([{ refusals: [REFUSAL], repliedSinceRefusal: true }]);
    expect(sent).toHaveLength(1);
  });

  it("explains the refusal once when the turn ended on it without a reply", () => {
    const { sent, exit } = run([
      { refusals: [REFUSAL], repliedSinceRefusal: false },
      { refusals: [], repliedSinceRefusal: true },
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[1]![0]).toContain(`- ${REFUSAL}`);
    expect(sent[1]![0]).toContain("Do not retry");
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("does not follow up a turn that was cancelled or cut off", () => {
    const { sent } = run([{ refusals: [REFUSAL], repliedSinceRefusal: false, stop: "cancelled" }]);
    expect(sent).toHaveLength(1);
  });

  it("fails the turn, naming the refusal, when the follow-ups end the same way", () => {
    const stuck = { refusals: [REFUSAL], repliedSinceRefusal: false };
    const { sent, exit } = run([stuck, stuck, stuck]);
    expect(sent).toHaveLength(1 + MAX_READ_ONLY_REFUSAL_FOLLOW_UPS);
    expect(exit).toEqual(Exit.fail(readOnlyRefusalFailureText("Antigravity", REFUSAL)));
    expect(readOnlyRefusalFailureText("Antigravity", REFUSAL)).toContain(REFUSAL);
  });

  it("counts only what happened since the last prompt", () => {
    // The second prompt saw no refusal of its own, so the first one's is not held against it.
    const { sent, exit } = run([
      { refusals: [REFUSAL], repliedSinceRefusal: false },
      { refusals: [], repliedSinceRefusal: false },
    ]);
    expect(sent).toHaveLength(2);
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("readOnlyRefusalFollowUpText", () => {
  it("lists the latest refusals and bounds each one", () => {
    const refusals = Array.from({ length: 7 }, (_, index) => `cmd-${index} (${"x".repeat(900)})`);
    const text = readOnlyRefusalFollowUpText(refusals);
    expect(text).toContain("F5 refused 7 operations");
    expect(text).not.toContain("cmd-1 ");
    expect(text).toContain("cmd-6 ");
    expect(text.length).toBeLessThan(5 * 700 + 600);
  });
});
