import {
  COPILOT_ACP_SESSION_EVENT,
  CopilotAcpSessionEvent,
  copilotAcpCapabilities,
  isCopilotAcpCommand,
  makeCopilotAcpRouting,
} from "./CopilotAcpRouting.ts";
import { type AcpSettings, type ServerProviderModel } from "@t3tools/contracts";
import { customModelSlug } from "@t3tools/shared/customModels";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { SessionConfigOption, SessionModelState } from "effect-acp/schema";
import { findModelConfigOption } from "./AcpRuntimeModel.ts";
import { AcpSessionRuntime, type AcpSpawnInput } from "./AcpSessionRuntime.ts";
import type { GrokAcpRuntimeInput } from "./GrokAcpSupport.ts";

export function customAcpSpawn(
  config: AcpSettings,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return { command: config.command, args: config.args, cwd, env: environment, extendEnv: false };
}

/** Authentication is owned by the selected local agent; F5 never picks an auth method. */
export function makeCustomAcpRuntime(config: AcpSettings, input: GrokAcpRuntimeInput) {
  return Effect.gen(function* () {
    const routing = isCopilotAcpCommand(config.command) ? makeCopilotAcpRouting() : undefined;
    if (routing) yield* Effect.addFinalizer(() => Effect.sync(routing.clear));
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: customAcpSpawn(config, input.cwd, input.environment ?? {}),
        customModels: config.customModels.map(customModelSlug),
        ...(routing
          ? {
              clientCapabilities: { _meta: copilotAcpCapabilities },
              normalizeSessionUpdate: routing.normalize,
            }
          : {}),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(context));
    if (routing)
      yield* runtime.handleExtNotification(
        COPILOT_ACP_SESSION_EVENT,
        CopilotAcpSessionEvent,
        (event) => Effect.sync(() => routing.onEvent(event)),
      );
    return {
      ...runtime,
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          const model = findModelConfigOption(yield* runtime.getConfigOptions);
          if (model) {
            yield* runtime.setConfigOption(model.id, modelId);
            return {};
          }
          return yield* runtime.setSessionModel(modelId);
        }),
    };
  });
}

/**
 * A configured model must come from this session's native model selector, never
 * another instance. The model config option wins; agents without one list
 * their models in the session model state, which `session/set_model` selects.
 */
export function customAcpModels(
  options: ReadonlyArray<SessionConfigOption>,
  modelState?: SessionModelState | null,
): ReadonlyArray<ServerProviderModel> {
  const model = findModelConfigOption(options);
  const choices = model
    ? model.options.flatMap((option) => ("value" in option ? [option] : option.options))
    : (modelState?.availableModels ?? []).map((choice) => ({
        value: choice.modelId,
        name: choice.name,
      }));
  const seen = new Set<string>();
  return choices
    .filter((choice) => {
      if (!choice.value.trim() || choice.value.length > 4096 || seen.has(choice.value))
        return false;
      seen.add(choice.value);
      return true;
    })
    .slice(0, 1000)
    .map((choice) => ({
      slug: choice.value,
      name: choice.name,
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    }));
}
