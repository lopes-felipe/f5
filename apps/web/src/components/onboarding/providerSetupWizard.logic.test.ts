import {
  DEFAULT_RUNTIME_MODE,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { RUNTIME_MODE_PRESENTATION } from "../chat/runtimeModePresentation";
import {
  classifyProviderReadiness,
  deriveWizardSteps,
  evaluateRuntimeModeCompatibility,
  RUNTIME_MODE_WIZARD_OPTIONS,
} from "./providerSetupWizard.logic";

const NOW_ISO = "2026-04-24T12:00:00.000Z";

function makeProvider(
  overrides: Partial<Omit<ServerProvider, "instanceId" | "driver">> & {
    instanceId: string;
    driver: string;
  },
): ServerProvider {
  const { instanceId, driver, ...rest } = overrides;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.2.3",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW_ISO,
    models: [],
    slashCommands: [],
    skills: [],
    ...rest,
  } as ServerProvider;
}

describe("providerSetupWizard.logic", () => {
  it("classifies ready, checking, needsAuth, needsAttention, and disabled providers", () => {
    const summary = classifyProviderReadiness([
      makeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude Code",
        status: "ready",
        auth: { status: "authenticated" },
      }),
      makeProvider({
        instanceId: "codex",
        driver: "codex",
        status: "warning",
        installed: true,
        auth: { status: "unauthenticated" },
        message: "Sign in to Codex CLI.",
      }),
      makeProvider({
        instanceId: "cursor",
        driver: "cursor",
        status: "error",
        installed: false,
        version: null,
        auth: { status: "unknown" },
        message: "Cursor agent binary not found.",
      }),
      makeProvider({
        instanceId: "grok",
        driver: "grok",
        enabled: false,
        status: "disabled",
      }),
    ]);

    expect(summary.ready).toHaveLength(1);
    expect(summary.ready[0]?.displayName).toBe("Claude Code");
    expect(summary.ready[0]?.hasCaveat).toBe(false);
    expect(summary.ready[0]?.authUnverified).toBe(false);
    expect(summary.checking).toHaveLength(0);
    expect(summary.needsAuth).toHaveLength(1);
    expect(summary.needsAttention).toHaveLength(1);
    expect(summary.needsAttention[0]?.installed).toBe(false);
    expect(summary.enabledCount).toBe(3);
    expect(summary.disabledCount).toBe(1);
    expect(summary.hasAnyReady).toBe(true);
  });

  it("handles warning variants (unprobed, checking, selectable caveat) and ready with unknown auth", () => {
    const summary = classifyProviderReadiness([
      makeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        status: "warning",
        installed: false,
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      }),
      makeProvider({
        instanceId: "cursor",
        driver: "cursor",
        status: "warning",
        installed: true,
        auth: { status: "unknown" },
        message: "Checking Cursor Agent availability...",
      }),
      makeProvider({
        instanceId: "codex",
        driver: "codex",
        status: "warning",
        installed: true,
        auth: { status: "authenticated" },
        message: "Codex CLI is slightly outdated.",
      }),
      makeProvider({
        instanceId: "cursor-ready",
        driver: "cursor",
        displayName: "Cursor Agent (unverified)",
        status: "ready",
        installed: true,
        auth: { status: "unknown" },
        message: "Account status could not be confirmed from CLI output.",
      }),
    ]);

    expect(summary.checking.map((p) => p.instanceId)).toEqual(["claudeAgent", "cursor"]);
    expect(summary.ready).toHaveLength(2);
    expect(summary.ready[0]).toMatchObject({
      instanceId: "codex",
      hasCaveat: true,
      authUnverified: false,
    });
    expect(summary.ready[1]).toMatchObject({
      instanceId: "cursor-ready",
      hasCaveat: false,
      authUnverified: true,
      message: "Account status could not be confirmed from CLI output.",
    });
    expect(summary.needsAttention).toHaveLength(0);
  });

  it("derives permission mode labels, warnings, and default badge from shared contracts", () => {
    expect(RUNTIME_MODE_WIZARD_OPTIONS.map((option) => option.value)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    for (const option of RUNTIME_MODE_WIZARD_OPTIONS) {
      expect(option.label).toBe(RUNTIME_MODE_PRESENTATION[option.value].label);
      expect(option.summary).toBe(RUNTIME_MODE_PRESENTATION[option.value].description);
      if (option.value === DEFAULT_RUNTIME_MODE) {
        expect(option.badge).toBe("Default");
      }
    }
    const autoOption = RUNTIME_MODE_WIZARD_OPTIONS.find((option) => option.value === "auto");
    expect(autoOption?.summary).toContain("risky commands without asking");
  });

  it("evaluates runtime mode compatibility against ready providers and availableRuntimeModes", () => {
    const museOnly = [
      { driver: "muse", displayName: "Muse Code", availableRuntimeModes: undefined },
    ];
    expect(evaluateRuntimeModeCompatibility("approval-required", museOnly).status).toBe(
      "unsupported",
    );
    expect(evaluateRuntimeModeCompatibility("auto-accept-edits", museOnly).status).toBe(
      "supported",
    );

    const mixed = [
      { driver: "muse", displayName: "Muse Code", availableRuntimeModes: undefined },
      { driver: "codex", displayName: "Codex", availableRuntimeModes: undefined },
    ];
    const mixedResult = evaluateRuntimeModeCompatibility("approval-required", mixed);
    expect(mixedResult.status).toBe("partial");
    expect(mixedResult.unsupportedProviders.map((p) => p.displayName)).toEqual(["Muse Code"]);

    const narrowedInstance = [
      {
        driver: "codex",
        displayName: "Codex Restricted",
        availableRuntimeModes: ["full-access"] as const,
      },
    ];
    expect(evaluateRuntimeModeCompatibility("auto", narrowedInstance).status).toBe("unsupported");
    expect(evaluateRuntimeModeCompatibility("full-access", narrowedInstance).status).toBe(
      "supported",
    );
  });

  it("advances guided step states as provider, permissions, and workspace complete", () => {
    expect(
      deriveWizardSteps({
        hasAnyReadyProvider: false,
        hasConfirmedRuntimeMode: false,
        hasProjects: false,
      }).map((step) => step.state),
    ).toEqual(["current", "upcoming", "upcoming"]);

    expect(
      deriveWizardSteps({
        hasAnyReadyProvider: true,
        hasConfirmedRuntimeMode: false,
        hasProjects: false,
      }).map((step) => step.state),
    ).toEqual(["complete", "current", "upcoming"]);

    expect(
      deriveWizardSteps({
        hasAnyReadyProvider: true,
        hasConfirmedRuntimeMode: true,
        hasProjects: false,
      }).map((step) => step.state),
    ).toEqual(["complete", "complete", "current"]);

    expect(
      deriveWizardSteps({
        hasAnyReadyProvider: true,
        hasConfirmedRuntimeMode: true,
        hasProjects: true,
      }).map((step) => step.state),
    ).toEqual(["complete", "complete", "complete"]);
  });
});
