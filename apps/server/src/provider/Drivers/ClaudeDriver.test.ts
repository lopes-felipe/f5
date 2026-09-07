import { Effect } from "effect";
import { it, assert } from "@effect/vitest";
import { resolveClaudeOneOffLaunchArgs } from "./ClaudeDriver.ts";

it.effect("invalid persisted launch arguments degrade only one-off arguments", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      yield* resolveClaudeOneOffLaunchArgs('--custom "unterminated', "claude-work"),
      {},
    );
    assert.deepEqual(
      yield* resolveClaudeOneOffLaunchArgs("--verbose --custom value", "claude-work"),
      { verbose: null, custom: "value" },
    );
  }),
);
