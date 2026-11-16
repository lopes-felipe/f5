import { hydrateCachedProvider } from "../providerStatusCache";
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

it("does not retain removed custom models during a transient probe failure", () => {
  const previous = makeProvider({
    checkedAt: "2026-08-14T00:00:00.000Z",
    outcome: "success",
    models: [MODEL, { ...MODEL, slug: "removed-custom", isCustom: true }],
  });
  const next = makeProvider({
    checkedAt: "2026-08-14T00:00:01.000Z",
    outcome: "transient_failure",
  });
  assert.deepStrictEqual(mergeProviderSnapshot(previous, next).models, [MODEL]);
});

it("leases reported models for 24 hours without renewing on failures or partial results", () => {
  const model = {
    ...MODEL,
    capabilities: { source: "reported" as const, optionDescriptors: [] },
    isUnlisted: true,
  };
  const previous = {
    ...makeProvider({ checkedAt: "2026-10-16T00:00:00.000Z", outcome: "success", models: [model] }),
    modelCatalog: { status: "complete" as const, lastSuccessAt: "2026-10-16T00:00:00.000Z" },
  };
  const failed = {
    ...makeProvider({ checkedAt: "2026-10-16T23:00:00.000Z", outcome: "transient_failure" }),
    modelCatalog: { status: "failed" as const },
  };
  const retained = mergeProviderSnapshot(previous, failed);
  assert.deepStrictEqual(retained.models, [model]);
  assert.strictEqual(retained.modelCatalog?.lastSuccessAt, previous.modelCatalog.lastSuccessAt);
  const partial = mergeProviderSnapshot(retained, {
    ...failed,
    checkedAt: "2026-10-16T23:59:00.000Z",
    modelCatalog: { status: "partial", firstPartialAt: "2026-10-16T23:59:00.000Z" },
  });
  assert.deepStrictEqual(partial.models, [model]);
  const expired = mergeProviderSnapshot(partial, {
    ...failed,
    checkedAt: "2026-10-17T00:00:00.000Z",
  });
  assert.deepStrictEqual(expired.models, []);
});

it("accepts explicit empty reported capabilities and drops omitted models on complete success", () => {
  const previous = {
    ...makeProvider({
      checkedAt: "2026-10-16T00:00:00.000Z",
      outcome: "success",
      models: [MODEL, { ...MODEL, slug: "discovered" }],
    }),
    modelCatalog: { status: "complete" as const, lastSuccessAt: "2026-10-16T00:00:00.000Z" },
  };
  const next = {
    ...previous,
    checkedAt: "2026-10-16T01:00:00.000Z",
    models: [{ ...MODEL, capabilities: { source: "reported" as const, optionDescriptors: [] } }],
  };
  const merged = mergeProviderSnapshot(previous, next);
  assert.deepStrictEqual(merged.models, next.models);
});

it("does not carry a catalog across CLI version or configuration changes", () => {
  const previous = {
    ...makeProvider({ checkedAt: "2026-10-16T00:00:00.000Z", outcome: "success", models: [MODEL] }),
    modelCatalog: { status: "complete" as const, lastSuccessAt: "2026-10-16T00:00:00.000Z" },
  };
  for (const change of [
    { version: "2.0.0" },
    { configurationFingerprint: "new" },
    { enabled: false },
  ]) {
    const next = {
      ...previous,
      ...change,
      checkedAt: "2026-10-16T01:00:00.000Z",
      models: [],
      modelCatalog: { status: "failed" as const },
    };
    assert.deepStrictEqual(mergeProviderSnapshot(previous, next).models, []);
  }
});

it("does not renew a first-partial lease without a successful catalog", () => {
  const previous = {
    ...makeProvider({ checkedAt: "2026-10-16T00:00:00.000Z", outcome: "success", models: [MODEL] }),
    modelCatalog: { status: "partial" as const, firstPartialAt: "2026-10-16T00:00:00.000Z" },
  };
  const next = {
    ...previous,
    checkedAt: "2026-10-16T23:00:00.000Z",
    models: [],
    modelCatalog: { status: "partial" as const, firstPartialAt: "2026-10-16T23:00:00.000Z" },
  };
  const retained = mergeProviderSnapshot(previous, next);
  assert.deepStrictEqual(retained.models, [MODEL]);
  assert.strictEqual(retained.modelCatalog?.firstPartialAt, previous.modelCatalog.firstPartialAt);
  assert.deepStrictEqual(
    mergeProviderSnapshot(retained, { ...next, checkedAt: "2026-10-17T00:00:00.000Z" }).models,
    [],
  );
});

it("retains a reported Claude gate override until its lease expires", () => {
  const reported = {
    slug: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    isCustom: false,
    isUnlisted: false,
    capabilities: { source: "reported" as const, supportsFastMode: true, optionDescriptors: [] },
  };
  const previous = {
    ...makeProvider({
      checkedAt: "2026-10-16T00:00:00.000Z",
      outcome: "success",
      models: [reported],
    }),
    modelCatalog: { status: "menu" as const, lastSuccessAt: "2026-10-16T00:00:00.000Z" },
  };
  const failed = {
    ...previous,
    checkedAt: "2026-10-16T12:00:00.000Z",
    auth: { status: "unknown" as const },
    models: [
      {
        ...reported,
        isUnlisted: true,
        capabilities: { source: "built-in" as const, optionDescriptors: [] },
      },
    ],
    modelCatalog: { status: "failed" as const },
  };
  const retained = mergeProviderSnapshot(previous, failed);
  assert.strictEqual(retained.models[0]?.isUnlisted, false);
  assert.deepStrictEqual(retained.models[0]?.capabilities, reported.capabilities);
  assert.strictEqual(retained.auth.email, undefined);
  const expired = mergeProviderSnapshot(retained, {
    ...failed,
    checkedAt: "2026-10-17T00:00:00.000Z",
  });
  assert.strictEqual(expired.models[0]?.isUnlisted, true);
  assert.strictEqual(expired.models[0]?.capabilities?.source, "built-in");
});

it("preserves legacy-driver capabilities on an empty lookup but accepts explicit reported emptiness", () => {
  const capabilities = createModelCapabilities({
    optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
  });
  const previous = makeProvider({
    checkedAt: "2026-10-16T00:00:00.000Z",
    outcome: "success",
    models: [{ ...MODEL, capabilities }],
  });
  const next = { ...previous, checkedAt: "2026-10-16T00:01:00.000Z", models: [MODEL] };
  assert.deepStrictEqual(
    mergeProviderSnapshot(previous, next).models[0]?.capabilities,
    capabilities,
  );
  const empty = { source: "reported" as const, optionDescriptors: [] };
  assert.deepStrictEqual(
    mergeProviderSnapshot(previous, { ...next, models: [{ ...MODEL, capabilities: empty }] })
      .models[0]?.capabilities,
    empty,
  );
});

it("clears firstPartialAt after a successful catalog", () => {
  const previous = {
    ...makeProvider({ checkedAt: "2026-10-16T00:00:00.000Z", outcome: "success" }),
    modelCatalog: { status: "partial" as const, firstPartialAt: "2026-10-16T00:00:00.000Z" },
  };
  const next = {
    ...previous,
    modelCatalog: { status: "complete" as const, lastSuccessAt: "2026-10-16T01:00:00.000Z" },
  };
  assert.strictEqual(mergeProviderSnapshot(previous, next).modelCatalog?.firstPartialAt, undefined);
});

it("retains the original lease through cache hydration and expires it after restart", () => {
  const cached = {
    ...makeProvider({
      checkedAt: "2026-10-16T00:00:00.000Z",
      outcome: "success",
      models: [
        {
          ...MODEL,
          capabilities: { source: "reported" as const, optionDescriptors: [] },
          isUnlisted: false,
        },
      ],
    }),
    auth: { status: "authenticated" as const, email: "previous@example.test" },
    modelCatalog: { status: "complete" as const, lastSuccessAt: "2026-10-16T00:00:00.000Z" },
  };
  const fallback = makeProvider({ checkedAt: "2026-10-16T23:00:00.000Z", outcome: "success" });
  const hydrated = hydrateCachedProvider({ cachedProvider: cached, fallbackProvider: fallback });
  const failed = {
    ...fallback,
    modelCatalog: { status: "failed" as const },
    auth: { status: "unknown" as const },
  };
  const retained = mergeProviderSnapshot(hydrated, failed);
  assert.deepStrictEqual(retained.models, cached.models);
  assert.strictEqual(retained.auth.email, undefined);
  assert.strictEqual(retained.modelCatalog?.lastSuccessAt, cached.modelCatalog.lastSuccessAt);
  assert.deepStrictEqual(
    mergeProviderSnapshot(retained, { ...failed, checkedAt: "2026-10-17T00:00:00.000Z" }).models,
    [],
  );
});
