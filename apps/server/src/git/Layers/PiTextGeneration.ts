import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Cause, Deferred, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TextGenerationError } from "../Errors.ts";
import { extractJsonObject } from "../Utils.ts";
import { makePromptTextGeneration, type StructuredTextRunner } from "../promptTextGeneration.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "../../provider/pi/launch.ts";
import { makePiRpcConnection, PiRpcError } from "../../provider/pi/PiRpc.ts";
import { piRecordField, piRecordString, parsePiModelSlug } from "../../provider/pi/PiProtocol.ts";
import type { PiLaunchSettings } from "../../provider/pi/PiMetadata.ts";
import type { OwnedOperation } from "../../provider/ownedOperation.ts";

const MAX_OUTPUT_BYTES = 512 * 1024;

/** Ephemeral metadata generation never launches project/user extensions or exposes tools. */
export const runPiMetadataPrompt = (input: {
  readonly settings: PiLaunchSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly beforeLaunch?: Effect.Effect<void, PiRpcError, import("effect").Scope.Scope>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (input.beforeLaunch) yield* input.beforeLaunch;
      const fs = yield* FileSystem.FileSystem;
      const parsed = resolvePiLaunchArgs(input.settings.launchArgs);
      if (!parsed.ok) return yield* new PiRpcError({ operation: "launch", detail: parsed.message });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "f5-pi-metadata-" });
      const launch = buildPiRpcLaunch({
        launchArgs: parsed.args,
        environment: input.environment,
        extensionPath: undefined,
        mcpSession: undefined,
        ephemeral: true,
        disableExtensions: true,
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: input.settings.binaryPath || "pi",
        args: launch.args,
        cwd,
        env: launch.env,
      });
      const done = yield* Deferred.make<string, PiRpcError>();
      const messages = new Map<number, string>();
      let ordinal = 0,
        bytes = 0,
        failure = false;
      const fail = (detail: string) =>
        Deferred.fail(done, new PiRpcError({ operation: "metadata", detail }));
      const remember = (value: string) =>
        Effect.gen(function* () {
          bytes += Buffer.byteLength(value) - Buffer.byteLength(messages.get(ordinal) ?? "");
          if (bytes > MAX_OUTPUT_BYTES || messages.size >= 256)
            return yield* fail("Pi metadata output exceeds its limit.");
          messages.set(ordinal, value);
        });
      yield* connection.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (
              event.type === "message_start" &&
              piRecordString(event.message, "role") === "assistant"
            )
              ordinal++;
            if (
              event.type === "message_update" &&
              piRecordString(event.assistantMessageEvent, "type") === "text_delta"
            ) {
              yield* remember(
                (messages.get(ordinal) ?? "") +
                  (piRecordString(event.assistantMessageEvent, "delta") ?? ""),
              );
            }
            if (
              event.type === "message_end" &&
              piRecordString(event.message, "role") === "assistant"
            ) {
              const content = piRecordField(event.message, "content");
              const text =
                typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content
                        .filter((part) => piRecordString(part, "type") === "text")
                        .map((part) => piRecordString(part, "text") ?? "")
                        .join("")
                    : "";
              yield* remember(text);
              if (piRecordString(event.message, "stopReason") === "error") failure = true;
            }
            if (event.type === "auto_retry_end") failure = event.success !== true;
            if (event.type === "tool_execution_start")
              yield* fail("Pi attempted to use a tool during metadata generation.");
            if (event.type === "extension_ui_request" && typeof event.id === "string")
              yield* connection.send({
                type: "extension_ui_response",
                id: event.id,
                cancelled: true,
              });
            if (event.type === "response" && event.success === false)
              yield* fail("Pi rejected metadata generation.");
            if (event.type === "agent_settled") {
              if (event.aborted === true || failure)
                yield* fail("Pi metadata generation did not complete successfully.");
              else yield* Deferred.succeed(done, [...messages.values()].join("\n").trim());
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.interrupt : fail("Pi metadata transport failed."),
        ),
        Effect.forkScoped,
      );
      if (input.model && input.model !== "default") {
        const model = parsePiModelSlug(input.model);
        if (!model)
          return yield* new PiRpcError({
            operation: "model",
            detail: "Pi model must use provider/model format.",
          });
        yield* connection.request({
          type: "set_model",
          provider: model.provider,
          modelId: model.modelId,
        });
      }
      if (input.thinking)
        yield* connection.request({ type: "set_thinking_level", level: input.thinking });
      yield* connection.send({ type: "prompt", message: input.prompt });
      return yield* Deferred.await(done);
    }),
  ).pipe(Effect.timeout("180 seconds"));

export const makePiTextGeneration = (
  settings: PiLaunchSettings,
  environment: NodeJS.ProcessEnv,
  beforeLaunch?: Parameters<typeof runPiMetadataPrompt>[0]["beforeLaunch"],
  ownOperation?: OwnedOperation<PiRpcError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runJson: StructuredTextRunner = (input) =>
      Effect.gen(function* () {
        const prompt = runPiMetadataPrompt({
          settings,
          environment,
          prompt: input.prompt,
          model: input.modelSelection?.model ?? input.model,
          thinking: getModelSelectionStringOptionValue(input.modelSelection, "thinking"),
          ...(beforeLaunch ? { beforeLaunch } : {}),
        });
        const text = yield* (ownOperation ? ownOperation(prompt) : prompt).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            () =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi metadata generation failed or timed out.",
              }),
          ),
        );
        return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
          extractJsonObject(text),
        ).pipe(
          Effect.catchTag("SchemaError", () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi returned invalid structured output.",
              }),
            ),
          ),
        );
      });
    return makePromptTextGeneration(runJson);
  });
