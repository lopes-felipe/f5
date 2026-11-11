import { Effect } from "effect";
import { AcpRequestError } from "effect-acp/errors";
import type { SessionConfigOption } from "effect-acp/schema";
import { describe, expect, it } from "vitest";
import { applyAcpPlanMode, makeAcpBuildConfiguration } from "./AcpPlanMode.ts";
import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";

const planId = "https://agentclientprotocol.com/protocol/session-modes#plan";
function fixture(native = true, categories = ["mode", "collaboration_mode"]) {
  let modes: AcpSessionModeState | undefined = native
    ? {
        currentModeId: "build",
        availableModes: [
          { id: "build", name: "Build" },
          { id: planId, name: "Plan" },
        ],
      }
    : undefined;
  let options: SessionConfigOption[] = categories.map((category) => ({
    id: category + "_selector",
    name: category,
    category,
    type: "select",
    currentValue: "build",
    options: [
      {
        group: "modes",
        name: "group",
        options: [
          { value: "build", name: "Build" },
          { value: planId, name: "Plan" },
        ],
      },
    ],
  }));
  const calls: unknown[] = [];
  let fail = false;
  const request = (method: string, value: string) =>
    Effect.gen(function* () {
      calls.push([method, value]);
      if (fail)
        return yield* new AcpRequestError({ code: -32603, errorMessage: "failed selection" });
    });
  const runtime = {
    getModeState: Effect.sync(() => modes),
    getConfigOptions: Effect.sync(() => options),
    setNativeMode: (value: string) =>
      request("session/set_mode", value).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (modes) modes = { ...modes, currentModeId: value };
          }),
        ),
      ),
    setConfigOption: (id: string, value: string | boolean) =>
      request(id, String(value)).pipe(
        Effect.map(() => {
          options = options.map((option) =>
            option.id === id ? ({ ...option, currentValue: value } as SessionConfigOption) : option,
          );
          return { configOptions: options };
        }),
      ),
  };
  return {
    runtime,
    calls,
    fail: () => {
      fail = true;
    },
    removeSelectors: () => {
      modes = undefined;
      options = [];
    },
    removeBuildValues: () => {
      if (modes)
        modes = {
          ...modes,
          availableModes: modes.availableModes.filter((mode) => mode.id !== "build"),
        };
      options = options.map(
        (option) =>
          ({
            ...option,
            options: [{ value: planId, name: "Plan" }],
          }) as SessionConfigOption,
      );
    },
  };
}

describe("native ACP Plan mode", () => {
  it("sets the native mode and every mode/collaboration selector, then restores them", async () => {
    const f = fixture();
    const state = makeAcpBuildConfiguration();
    await Effect.runPromise(applyAcpPlanMode(f.runtime, true, state));
    await Effect.runPromise(applyAcpPlanMode(f.runtime, true, state));
    await Effect.runPromise(applyAcpPlanMode(f.runtime, false, state));
    expect(f.calls).toEqual([
      ["session/set_mode", planId],
      ["mode_selector", planId],
      ["collaboration_mode_selector", planId],
      ["session/set_mode", "build"],
      ["mode_selector", "build"],
      ["collaboration_mode_selector", "build"],
    ]);
    expect(state.options.size).toBe(0);
    expect(state.modeId).toBeUndefined();
  });
  it("supports collaboration-only agents without native modes", async () => {
    const f = fixture(false, ["collaboration_mode"]);
    const state = makeAcpBuildConfiguration();
    await Effect.runPromise(applyAcpPlanMode(f.runtime, true, state));
    await Effect.runPromise(applyAcpPlanMode(f.runtime, false, state));
    expect(f.calls).toEqual([
      ["collaboration_mode_selector", planId],
      ["collaboration_mode_selector", "build"],
    ]);
  });
  it.each(["removeSelectors", "removeBuildValues"] as const)(
    "does not restore removed selectors or values (%s)",
    async (remove) => {
      const f = fixture();
      const state = makeAcpBuildConfiguration();
      await Effect.runPromise(applyAcpPlanMode(f.runtime, true, state));
      f[remove]();
      await Effect.runPromise(applyAcpPlanMode(f.runtime, false, state));
      expect(f.calls).toHaveLength(3);
      expect(state.options.size).toBe(0);
      expect(state.modeId).toBeUndefined();
    },
  );
  it("logs failed restoration and discards it rather than blocking future turns", async () => {
    const f = fixture();
    const state = makeAcpBuildConfiguration();
    await Effect.runPromise(applyAcpPlanMode(f.runtime, true, state));
    f.fail();
    await Effect.runPromise(applyAcpPlanMode(f.runtime, false, state));
    await Effect.runPromise(applyAcpPlanMode(f.runtime, false, state));
    expect(f.calls).toHaveLength(6);
  });
  it.each([true, false])(
    "fails closed with the correct method on Plan entry (native: %s)",
    async (native) => {
      const f = fixture(native, native ? [] : ["collaboration_mode"]);
      f.fail();
      const result = await Effect.runPromise(
        applyAcpPlanMode(f.runtime, true, makeAcpBuildConfiguration()).pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          method: native ? "session/set_mode" : "session/set_config_option",
        },
      });
    },
  );
});
