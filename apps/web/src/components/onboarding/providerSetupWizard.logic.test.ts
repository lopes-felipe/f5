import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyProviderReadiness,
  deriveWizardSteps,
  getProviderLoginHint,
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
  it("classifies ready, needsAuth, needsAttention, and disabled providers", () => {
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
    expect(summary.needsAuth).toHaveLength(1);
    expect(summary.needsAuth[0]?.loginCommand).toBe("codex login");
    expect(summary.needsAttention).toHaveLength(1);
    expect(summary.needsAttention[0]?.installed).toBe(false);
    expect(summary.enabledCount).toBe(3);
    expect(summary.disabledCount).toBe(1);
    expect(summary.hasAnyReady).toBe(true);
    expect(summary.nextRecommendedAction).toBe("ready");
  });

  it("recommends sign-in when no provider is ready but one needs authentication", () => {
    const summary = classifyProviderReadiness([
      makeProvider({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        status: "warning",
        installed: true,
        auth: { status: "unauthenticated" },
      }),
    ]);

    expect(summary.hasAnyReady).toBe(false);
    expect(summary.nextRecommendedAction).toBe("sign-in");
  });

  it("recommends installing a provider when none are ready or awaiting sign-in", () => {
    const summary = classifyProviderReadiness([
      makeProvider({
        instanceId: "codex",
        driver: "codex",
        status: "error",
        installed: false,
        auth: { status: "unknown" },
      }),
    ]);

    expect(summary.nextRecommendedAction).toBe("install-provider");
  });

  it("returns fallback hints for unknown fork drivers", () => {
    expect(getProviderLoginHint("claudeAgent")).toEqual({
      displayName: "Claude Code",
      loginCommand: "claude auth login",
    });
    expect(getProviderLoginHint("customForkDriver")).toEqual({
      displayName: "customForkDriver",
      loginCommand: null,
    });
  });

  it("exposes all four runtime modes in plain English", () => {
    expect(RUNTIME_MODE_WIZARD_OPTIONS.map((option) => option.value)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
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
