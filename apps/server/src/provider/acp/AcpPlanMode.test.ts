import { Effect } from "effect";
import { AcpRequestError } from "effect-acp/errors";
import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "effect-acp/schema";
import { makeAcpPlanModeSwitcher } from "./AcpPlanMode.ts";

describe("native ACP Plan mode", () => {
  it("retains the original mode when restoration fails so the next turn can retry", async () => {
    const calls: unknown[] = [];
    let failRestore = true;
    const switchMode = makeAcpPlanModeSwitcher(
      {
        getConfigOptions: Effect.succeed([]),
        getModeState: Effect.succeed({
          currentModeId: "agent",
          availableModes: [{ id: "plan", name: "Plan" }],
        }),
        setConfigOption: () => Effect.die("unexpected config change"),
        request: (_method, payload) =>
          Effect.gen(function* () {
            calls.push(payload);
            if (calls.length === 2 && failRestore)
              return yield* new AcpRequestError({ code: -32603, errorMessage: "try again" });
          }),
      },
      "session-1",
    );
    await Effect.runPromise(switchMode(true));
    await expect(Effect.runPromise(switchMode(false))).rejects.toThrow("try again");
    failRestore = false;
    await Effect.runPromise(switchMode(false));
    expect(calls).toEqual(
      ["plan", "agent", "agent"].map((modeId) => ({
        sessionId: "session-1",
        modeId,
      })),
    );
  });

  it.each([
    "plan",
    "architect",
    "https://agentclientprotocol.com/protocol/session-modes#plan",
    "https://example.test/modes#architect",
  ])("selects and restores %s through both ACP selectors", async (planId) => {
    for (const config of [false, true]) {
      const calls: unknown[] = [];
      const options: SessionConfigOption[] = config
        ? [
            {
              id: "agent_mode",
              name: "Mode",
              category: "mode",
              type: "select",
              currentValue: "agent",
              options: [
                { value: "agent", name: "Build" },
                { value: planId, name: "Review" },
              ],
            },
          ]
        : [];
      const switchMode = makeAcpPlanModeSwitcher(
        {
          getConfigOptions: Effect.succeed(options),
          getModeState: Effect.succeed({
            currentModeId: "agent",
            availableModes: [{ id: planId, name: "Review" }],
          }),
          setConfigOption: (configId, value) =>
            Effect.sync(() => {
              calls.push({ configId, value });
              return { configOptions: options };
            }),
          request: (method, payload) =>
            Effect.sync(() => {
              calls.push({ method, payload });
            }),
        },
        "session-1",
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* switchMode(false);
          yield* switchMode(true);
          yield* switchMode(true);
          yield* switchMode(false);
          yield* switchMode(false);
        }),
      );
      expect(calls).toEqual(
        config
          ? [
              { configId: "agent_mode", value: planId },
              { configId: "agent_mode", value: "agent" },
            ]
          : [planId, "agent"].map((modeId) => ({
              method: "session/set_mode",
              payload: { sessionId: "session-1", modeId },
            })),
      );
    }
  });

  it("leaves unadvertised and unrelated modes alone", async () => {
    const switchMode = makeAcpPlanModeSwitcher(
      {
        getConfigOptions: Effect.succeed([]),
        getModeState: Effect.succeed({
          currentModeId: "agent",
          availableModes: [{ id: "https://plan.test/#agent", name: "Plan" }],
        }),
        setConfigOption: () => Effect.die("unexpected configuration change"),
        request: () => Effect.die("unexpected mode change"),
      },
      "session-1",
    );
    await Effect.runPromise(switchMode(true));
    await Effect.runPromise(switchMode(false));
  });
});
