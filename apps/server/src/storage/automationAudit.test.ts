import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { listStorageAutomationAudit, recordStorageAutomationAudit } from "./automationAudit.ts";

it.layer(SqlitePersistenceMemory)("recordStorageAutomationAudit", (it) => {
  it.effect("skips a row that repeats the newest result and reason for its target", () =>
    Effect.gen(function* () {
      const failed = (target: string, reason: string, operationId: string) =>
        recordStorageAutomationAudit(
          {
            operationId,
            job: "codex-marketplace-staging",
            target,
            result: "failed",
            reason,
          },
          { skipIfRepeated: true },
        );

      yield* failed("~/.codex/a", "EACCES", "pass-1");
      yield* failed("~/.codex/a", "EACCES", "pass-2");
      yield* failed("~/.codex/b", "EACCES", "pass-2");
      yield* failed("~/.codex/a", "EBUSY", "pass-3");
      // Without the option every pass is recorded.
      yield* recordStorageAutomationAudit({
        operationId: "pass-4",
        job: "codex-marketplace-staging",
        target: "~/.codex/a",
        result: "failed",
        reason: "EBUSY",
      });

      const rows = yield* listStorageAutomationAudit(10);
      assert.deepStrictEqual(
        rows.map((row) => [row.operationId, row.target, row.reason]).toSorted(),
        [
          ["pass-1", "~/.codex/a", "EACCES"],
          ["pass-2", "~/.codex/b", "EACCES"],
          ["pass-3", "~/.codex/a", "EBUSY"],
          ["pass-4", "~/.codex/a", "EBUSY"],
        ],
      );
    }),
  );
});
