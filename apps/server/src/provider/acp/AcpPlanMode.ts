import { Effect } from "effect";
import type { AcpError } from "effect-acp/errors";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

export function isAcpPlanModeId(id: string): boolean {
  const name = id.slice(id.lastIndexOf("#") + 1);
  return name === "plan" || name === "architect";
}

export interface AcpBuildConfiguration {
  modeId?: string;
  readonly options: Map<string, string>;
}

/** Owned by the native session, independently of its current transport. */
export const makeAcpBuildConfiguration = (): AcpBuildConfiguration => ({ options: new Map() });

export interface AcpPlanModeError {
  readonly method: "session/set_mode" | "session/set_config_option";
  readonly cause: AcpError;
}

export function applyAcpPlanMode(
  runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "getModeState" | "setConfigOption" | "setNativeMode"
  >,
  plan: boolean,
  previous: AcpBuildConfiguration,
) {
  return Effect.gen(function* () {
    const modes = yield* runtime.getModeState;
    const options = (yield* runtime.getConfigOptions).filter(
      (option) =>
        option.category === "mode" ||
        option.category === "collaboration_mode" ||
        option.id === "mode",
    );
    const setMode = (value: string) =>
      runtime
        .setNativeMode(value)
        .pipe(
          Effect.mapError((cause): AcpPlanModeError => ({ method: "session/set_mode", cause })),
        );
    const setOption = (id: string, value: string) =>
      runtime.setConfigOption(id, value).pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause): AcpPlanModeError => ({ method: "session/set_config_option", cause }),
        ),
      );
    // Removed values cannot be restored. Failed restoration must not permanently
    // prevent Default turns; entering Plan still fails closed.
    const restore = (effect: Effect.Effect<void, AcpPlanModeError>) =>
      effect.pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not restore an ACP build mode; discarding its saved selection."),
        ),
      );
    if (!plan) {
      if (previous.modeId && modes?.availableModes.some((mode) => mode.id === previous.modeId))
        yield* restore(setMode(previous.modeId));
      delete previous.modeId;
      for (const [id, value] of previous.options) {
        const option = options.find((option) => option.id === id);
        if (
          option &&
          "options" in option &&
          option.options.some((entry) =>
            "value" in entry
              ? entry.value === value
              : entry.options.some((choice) => choice.value === value),
          )
        )
          yield* restore(setOption(id, value));
        previous.options.delete(id);
      }
      return;
    }
    const requested = modes?.availableModes.find((mode) => isAcpPlanModeId(mode.id));
    if (modes && requested && requested.id !== modes.currentModeId) {
      const before = modes.currentModeId;
      yield* setMode(requested.id);
      previous.modeId ??= before;
    }
    for (const option of options) {
      if (!("options" in option)) continue;
      const choices = option.options.flatMap((entry) =>
        "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
      );
      const requested = choices.find(isAcpPlanModeId);
      if (requested && requested !== option.currentValue) {
        yield* setOption(option.id, requested);
        if (!previous.options.has(option.id)) previous.options.set(option.id, option.currentValue);
      }
    }
  });
}
