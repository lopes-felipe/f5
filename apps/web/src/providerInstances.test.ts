import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  resolveDefaultProviderModelSelection,
  resolveComposerProviderInstance,
  resolveSelectableProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("usable provider defaults", () => {
  const codex = provider({
    provider: ProviderDriverKind.make("codex"),
    instanceId: "codex",
    status: "error",
  });
  const claude = provider({
    provider: ProviderDriverKind.make("claudeAgent"),
    instanceId: "claude_work",
    models: [{ slug: "my-model", name: "My model", isCustom: false, capabilities: {} }],
  });

  it("chooses a ready non-Codex instance and its own model", () => {
    expect(resolveDefaultProviderModelSelection([codex, claude], null)).toEqual({
      instanceId: "claude_work",
      model: "my-model",
    });
    expect(getDefaultProviderInstanceModel([codex, claude], claude.instanceId)).toBe("my-model");
    expect(resolveDefaultProviderModelSelection([codex], null)).toBeNull();
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
  });

  it("retains an explicitly requested errored instance and its options", () => {
    const stored = {
      instanceId: codex.instanceId,
      model: "custom",
      options: [{ id: "effort", value: "high" }],
    };
    expect(resolveDefaultProviderModelSelection([codex, claude], stored)).toBe(stored);
  });

  it("falls back from a disabled persisted provider without crossing a thread lock", () => {
    const disabled = { ...codex, enabled: false };
    const entries = deriveProviderInstanceEntries([disabled, claude]);
    const input = {
      candidates: [codex.instanceId],
      preferredDriver: codex.driver,
      lockedDriver: null,
    };
    expect(resolveComposerProviderInstance(entries, input)?.instanceId).toBe(claude.instanceId);
    expect(
      resolveComposerProviderInstance(entries, { ...input, lockedDriver: codex.driver }),
    ).toBeUndefined();
    expect(
      resolveDefaultProviderModelSelection([disabled, claude], {
        instanceId: codex.instanceId,
        model: "stale",
      }),
    ).toEqual({ instanceId: claude.instanceId, model: "my-model" });
  });

  it("never silently moves a started thread to a sibling native instance", () => {
    const entries = deriveProviderInstanceEntries([
      { ...claude, enabled: false, continuation: { groupKey: "group-a" } },
      {
        ...claude,
        instanceId: ProviderInstanceId.make("other"),
        continuation: { groupKey: "group-b" },
      },
      {
        ...claude,
        instanceId: ProviderInstanceId.make("compatible"),
        continuation: { groupKey: "group-a" },
      },
    ]);
    expect(
      resolveComposerProviderInstance(entries, {
        candidates: [claude.instanceId],
        preferredDriver: claude.driver,
        lockedDriver: claude.driver,
        lockedInstanceId: claude.instanceId,
      }),
    ).toBeUndefined();
    expect(
      resolveComposerProviderInstance(entries, {
        candidates: [claude.instanceId],
        preferredDriver: claude.driver,
        lockedDriver: null,
      })?.instanceId,
    ).toBe("other");
    expect(
      resolveComposerProviderInstance(entries, {
        candidates: [ProviderInstanceId.make("deleted")],
        preferredDriver: claude.driver,
        lockedDriver: claude.driver,
        lockedInstanceId: ProviderInstanceId.make("deleted"),
      }),
    ).toBeUndefined();
  });

  it("prefers an unprobed instance over an implicit errored default", () => {
    const warning = { ...claude, status: "warning" as const };
    expect(resolveSelectableProviderInstance([codex, warning], undefined)).toBe(claude.instanceId);
  });
});

it.each(["constructor", "toString"])(
  "does not retain a deleted provider instance named %s",
  (instanceId) => {
    const snapshot = provider({ provider: ProviderDriverKind.make("codex"), instanceId });
    expect(deriveProviderInstanceEntries([snapshot])).toHaveLength(1);
    expect(deriveProviderInstanceEntries([])).toEqual([]);
    expect(
      resolveSelectableProviderInstance([], ProviderInstanceId.make(instanceId)),
    ).toBeUndefined();
  },
);

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("claude_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("codex");
    const unavailable = ProviderInstanceId.make("claudeAgent");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("resolveProviderDriverKindForInstanceSelection", () => {
  it("maps custom provider instance ids back to their driver kind", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        displayName: "Claude OpenRouter",
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("claude_openrouter"),
      ),
    ).toBe("claudeAgent");
  });

  it("does not guess a provider kind when the instance selection is unknown", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("removed_instance"),
      ),
    ).toBeUndefined();
  });
});

it("rejects prototype-mutating instance IDs", () => {
  expect(() => ProviderInstanceId.make("__proto__")).toThrow();
});
