import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  MAX_READ_ONLY_REFUSAL_FOLLOW_UPS,
  MAX_READ_ONLY_REFUSAL_FOLLOW_UPS_PER_TURN,
  promptWithReadOnlyRefusalFollowUps,
  readOnlyRefusalFailureText,
  readOnlyRefusalFollowUpText,
  readOnlyRefusalText,
  type ReadOnlyRefusal,
  type ReadOnlyRefusalState,
} from "./AcpReadOnlyRefusalFollowUp.ts";

const REASON = "`touch` is not on the read-only allowlist";
const REFUSAL: ReadOnlyRefusal = { operation: "touch marker", reason: REASON };
const refusalOf = (index: number): ReadOnlyRefusal => ({
  operation: `touch marker-${index}`,
  reason: REASON,
});

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
      fail: (reason) => readOnlyRefusalFailureText("Antigravity", reason),
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
    expect(sent[1]![0]).toContain(`- touch marker (${REASON})`);
    expect(sent[1]![0]).toContain("Do not retry");
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("does not follow up a turn that was cancelled or cut off", () => {
    const { sent } = run([{ refusals: [REFUSAL], repliedSinceRefusal: false, stop: "cancelled" }]);
    expect(sent).toHaveLength(1);
  });

  it("fails the turn when the agent keeps ending on an operation F5 already explained", () => {
    const stuck = { refusals: [REFUSAL], repliedSinceRefusal: false };
    const { sent, exit } = run([stuck, stuck, stuck]);
    expect(sent).toHaveLength(1 + MAX_READ_ONLY_REFUSAL_FOLLOW_UPS);
    expect(exit).toEqual(Exit.fail(readOnlyRefusalFailureText("Antigravity", REASON)));
  });

  it("keeps explaining while the agent tries something different each time", () => {
    // Antigravity ends its turn on every refusal, so a model that changes its command after
    // each follow-up must not run out of them after two.
    const different = Array.from({ length: 6 }, (_, index) => ({
      refusals: [refusalOf(index)],
      repliedSinceRefusal: false,
    }));
    const { sent, exit } = run([...different, { refusals: [], repliedSinceRefusal: true }]);
    expect(sent).toHaveLength(7);
    expect(sent[6]![0]).toContain("touch marker-5");
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("starts the count over when a different operation comes between two repeats", () => {
    const repeat = { refusals: [REFUSAL], repliedSinceRefusal: false };
    const other = { refusals: [refusalOf(1)], repliedSinceRefusal: false };
    // repeat (explained), repeat (unheeded 1), other (new: 0), repeat (unheeded 1), reply.
    const { sent, exit } = run([
      repeat,
      repeat,
      other,
      repeat,
      { refusals: [], repliedSinceRefusal: true },
    ]);
    expect(sent).toHaveLength(5);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("stops after the turn's limit of follow-ups, however different the operations are", () => {
    const different = Array.from(
      { length: MAX_READ_ONLY_REFUSAL_FOLLOW_UPS_PER_TURN + 1 },
      (_, index) => ({ refusals: [refusalOf(index)], repliedSinceRefusal: false }),
    );
    const { sent, exit } = run(different);
    expect(sent).toHaveLength(1 + MAX_READ_ONLY_REFUSAL_FOLLOW_UPS_PER_TURN);
    expect(Exit.isFailure(exit)).toBe(true);
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

describe("readOnlyRefusalFailureText", () => {
  it("carries F5's reason and never the refused operation", () => {
    // The failure reaches the server log; the command can hold a credential the model wrote.
    const secret: ReadOnlyRefusal = {
      operation: 'gh api -H "Authorization: Bearer ghp_secret" /user -X POST',
      reason: "`gh api` may only send GET requests",
    };
    const stuck = { refusals: [secret], repliedSinceRefusal: false };
    const { exit } = run([stuck, stuck, stuck]);
    const text = readOnlyRefusalFailureText("Antigravity", secret.reason);
    expect(exit).toEqual(Exit.fail(text));
    expect(text).toContain(secret.reason);
    expect(text).not.toContain("ghp_secret");
    expect(text).not.toContain("Authorization");
  });
});

describe("readOnlyRefusalText", () => {
  it("is the reason alone when the request named no operation", () => {
    expect(readOnlyRefusalText({ operation: undefined, reason: REASON })).toBe(REASON);
    expect(readOnlyRefusalText(REFUSAL)).toBe(`touch marker (${REASON})`);
  });
});

describe("readOnlyRefusalFollowUpText", () => {
  it("lists the latest refusals and bounds each one", () => {
    const refusals = Array.from({ length: 7 }, (_, index) => ({
      operation: `cmd-${index}`,
      reason: "x".repeat(900),
    }));
    const text = readOnlyRefusalFollowUpText(refusals);
    expect(text).toContain("F5 refused 7 operations");
    expect(text).not.toContain("cmd-1 ");
    expect(text).toContain("cmd-6 ");
    expect(text.length).toBeLessThan(5 * 700 + 600);
  });

  it("keeps the reason of a command too long to quote in full", () => {
    const text = readOnlyRefusalFollowUpText([
      { operation: `cat ${"very/long/path/".repeat(80)}x > out`, reason: REASON },
    ]);
    expect(text).toContain("- cat very/long/path/");
    expect(text).toContain(`… (${REASON})`);
    expect(text).not.toContain("x > out");
  });

  it("points at the rules sent with the stage's request", () => {
    // Antigravity gets the rules in its first prompt, not in instructions.
    expect(readOnlyRefusalFollowUpText([REFUSAL])).toContain(
      "Read-Only Shell Rules sent with this stage's request",
    );
  });
});
