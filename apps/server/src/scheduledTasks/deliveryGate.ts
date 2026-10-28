import type {
  ClientThreadTurnStartCommand,
  ModelSelection,
  ScheduledTask,
} from "@t3tools/contracts";
import { canonicalJsonHash } from "../canonicalJsonHash.ts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderTurnDeliveryError } from "../provider/Errors.ts";
import { scheduledSendGate } from "./sendGate.ts";
/** The provider has not received a send here, so a closed gate is provably not-sent. */
export const assertScheduledDeliveryAllowed = (
  commandId: string | undefined,
  actual?: { instanceId: string; model: string; modelSelection?: ModelSelection | undefined },
) =>
  Effect.gen(function* () {
    if (!commandId) return;
    const sql = yield* SqlClient.SqlClient,
      settings = yield* (yield* ServerSettingsService).getSettings;
    const gate = yield* scheduledSendGate(sql, settings, commandId);
    if (gate !== "ready")
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: gate === "wait",
        detail: "Scheduled execution is fenced or waiting for authorization/capacity.",
      });
    if (actual) {
      const rows = yield* sql<{
        snapshot: string;
        command: string | null;
        runtime_mode: string | null;
        interaction_mode: string | null;
      }>`SELECT r.snapshot_json AS snapshot,r.command_json AS command,t.runtime_mode,t.interaction_mode FROM scheduled_run_submissions s JOIN scheduled_task_runs r ON r.id=s.run_id LEFT JOIN projection_threads t ON t.thread_id=s.thread_id WHERE s.submission_id=${commandId}`;
      if (rows[0]) {
        const task = JSON.parse(rows[0].snapshot) as ScheduledTask;
        // The admitted command is the single source of settings; a bound run's
        // snapshot only describes the thread when the task was saved.
        const command = rows[0].command
          ? (JSON.parse(rows[0].command) as ClientThreadTurnStartCommand)
          : null;
        const admitted = {
          modelSelection: command?.modelSelection ?? task.modelSelection,
          runtimeMode: command?.runtimeMode ?? task.runtimeMode,
        };
        if (
          actual.instanceId !== admitted.modelSelection.instanceId ||
          actual.model !== admitted.modelSelection.model ||
          rows[0].runtime_mode !== admitted.runtimeMode ||
          (task.workspace?.kind === "thread" &&
            rows[0].interaction_mode !== (command?.interactionMode ?? task.interactionMode)) ||
          (actual.modelSelection &&
            canonicalJsonHash(actual.modelSelection) !== canonicalJsonHash(admitted.modelSelection))
        )
          return yield* new ProviderTurnDeliveryError({
            certainty: "not_sent",
            retryable: false,
            detail:
              "The provider, model, options or runtime mode no longer match this scheduled execution. Review the run in F5.",
          });
      }
    }
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(ProviderTurnDeliveryError)(error)
        ? error
        : new ProviderTurnDeliveryError({
            certainty: "not_sent",
            retryable: true,
            detail: "Scheduled authorization could not be verified.",
            cause: error,
          }),
    ),
  );
