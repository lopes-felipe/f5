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
      yield* resolveClaudeOneOffLaunchArgs(
        "--verbose --custom value --add-dir one two",
        "claude-work",
      ),
      { launchArgs: { verbose: null, custom: "value" }, additionalDirectories: ["one", "two"] },
    );
  }),
);
