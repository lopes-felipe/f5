import { Effect } from "effect";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

export function isAcpPlanModeId(id: string): boolean {
  const name = id.slice(id.lastIndexOf("#") + 1);
  return name === "plan" || name === "architect";
}

/** Preserve the agent's build default while temporarily selecting its native Plan mode. */
export function makeAcpPlanModeSwitcher(
  runtime: Pick<
    AcpSessionRuntimeShape,
    "getConfigOptions" | "getModeState" | "setConfigOption" | "request"
  >,
  sessionId: string,
) {
  let previous: { value: string; configId?: string } | undefined;
  const select = (value: string, configId?: string) =>
    configId
      ? runtime.setConfigOption(configId, value).pipe(Effect.asVoid)
      : runtime.request("session/set_mode", { sessionId, modeId: value }).pipe(Effect.asVoid);
  return (plan: boolean) =>
    Effect.gen(function* () {
      if (!plan) {
        if (previous) {
          yield* select(previous.value, previous.configId);
          previous = undefined;
        }
        return;
      }
      if (previous) return;
      const options = yield* runtime.getConfigOptions;
      for (const option of options) {
        if (!("options" in option) || (option.category !== "mode" && option.id !== "mode"))
          continue;
        const choices = option.options.flatMap((entry) =>
          "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
        );
        const requested = choices.find(isAcpPlanModeId);
        if (requested && requested !== option.currentValue) {
          yield* select(requested, option.id);
          previous = { value: option.currentValue, configId: option.id };
          return;
        }
        if (requested) return;
      }
      const modes = yield* runtime.getModeState;
      const requested = modes?.availableModes.find((mode) => isAcpPlanModeId(mode.id));
      if (modes && requested && requested.id !== modes.currentModeId) {
        yield* select(requested.id);
        previous = { value: modes.currentModeId };
      }
    });
}
