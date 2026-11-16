import { Effect } from "effect";
import { startOwnedSetupScript } from "./ownedSetupScript.ts";

/** One owned process for synchronous project hooks; scope cancellation waits for process exit. */
export function runOwnedProjectScript(input: {
  command: string;
  name: string;
  cwd: string;
  env: Record<string, string>;
  purpose: "Setup" | "Settlement";
}) {
  return Effect.scoped(
    Effect.gen(function* () {
      const tail: string[] = [];
      const owned = yield* Effect.acquireRelease(
        startOwnedSetupScript({
          ...input,
          onLine: (line) => {
            tail.push(line);
            if (tail.length > 20) tail.shift();
          },
        }),
        (script) => script.kill,
      );
      const code = yield* owned.exit;
      if (code !== 0)
        return yield* Effect.fail(
          new Error(
            `${input.purpose} script '${input.name}' failed (${code ?? "no exit code"}).${tail.length ? `\n${tail.join("\n")}` : ""}`,
          ),
        );
    }),
  );
}
