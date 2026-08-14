import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderProbeOutcome,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { assert, it } from "@effect/vitest";

import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

const DRIVER = ProviderDriverKind.make("opencode");
const INSTANCE_ID = ProviderInstanceId.make("opencode");
const MODEL = {
  slug: "openai/gpt-5",
  name: "GPT-5",
  isCustom: false,
  capabilities: createModelCapabilities({ optionDescriptors: [] }),
} as const;

function makeProvider(input: {
  readonly checkedAt: string;
  readonly outcome: ServerProviderProbeOutcome;
  readonly outcomeStartedAt?: string;
  readonly models?: ServerProvider["models"];
}): ServerProvider {
  const enabled = input.outcome !== "disabled";
  const installed = input.outcome !== "loading" && input.outcome !== "missing";
  return {
    instanceId: INSTANCE_ID,
    driver: DRIVER,
    enabled,
    installed,
    version: installed ? "1.0.0" : null,
    status:
      input.outcome === "success"
        ? "ready"
        : input.outcome === "disabled"
          ? "disabled"
          : input.outcome === "loading"
            ? "warning"
            : "error",
    auth: { status: input.outcome === "success" ? "authenticated" : "unknown" },
    checkedAt: input.checkedAt,
    probeOutcome: input.outcome,
    ...(input.outcomeStartedAt ? { probeOutcomeStartedAt: input.outcomeStartedAt } : {}),
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

it("clears models after authoritative successful-empty, disabled, and missing probes", () => {
  const previous = makeProvider({
    checkedAt: "2026-08-14T00:00:00.000Z",
    outcome: "success",
    models: [MODEL],
  });

  for (const outcome of ["success", "disabled", "missing"] as const) {
    const merged = mergeProviderSnapshot(
      previous,
      makeProvider({ checkedAt: "2026-08-14T00:01:00.000Z", outcome }),
    );
    assert.deepStrictEqual(merged.models, [], outcome);
  }
});

it("retains models while a probe is loading", () => {
  const previous = makeProvider({
    checkedAt: "2026-08-14T00:00:00.000Z",
    outcome: "success",
    models: [MODEL],
  });
  const merged = mergeProviderSnapshot(
    previous,
    makeProvider({ checkedAt: "2026-08-14T00:01:00.000Z", outcome: "loading" }),
  );

  assert.deepStrictEqual(merged.models, [MODEL]);
});

it("bounds model retention across a transient failure window", () => {
  const previous = makeProvider({
    checkedAt: "2026-08-14T00:00:00.000Z",
    outcome: "success",
    models: [MODEL],
  });
  const firstFailure = mergeProviderSnapshot(
    previous,
    makeProvider({ checkedAt: "2026-08-14T00:01:00.000Z", outcome: "transient_failure" }),
  );
  assert.deepStrictEqual(firstFailure.models, [MODEL]);

  const withinWindow = mergeProviderSnapshot(
    firstFailure,
    makeProvider({ checkedAt: "2026-08-14T00:01:29.000Z", outcome: "transient_failure" }),
  );
  assert.deepStrictEqual(withinWindow.models, [MODEL]);

  const afterWindow = mergeProviderSnapshot(
    withinWindow,
    makeProvider({ checkedAt: "2026-08-14T00:01:31.000Z", outcome: "transient_failure" }),
  );
  assert.deepStrictEqual(afterWindow.models, []);
});
