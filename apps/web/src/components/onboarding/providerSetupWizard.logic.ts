import type { RuntimeMode, ServerProvider, ServerProviderAuthStatus } from "@t3tools/contracts";

export interface ProviderLoginHint {
  readonly displayName: string;
  readonly loginCommand: string | null;
}

const BUILTIN_PROVIDER_LOGIN_HINTS: Readonly<Record<string, ProviderLoginHint>> = {
  codex: {
    displayName: "Codex",
    loginCommand: "codex login",
  },
  claudeAgent: {
    displayName: "Claude Code",
    loginCommand: "claude auth login",
  },
  cursor: {
    displayName: "Cursor Agent",
    loginCommand: "agent login",
  },
  opencode: {
    displayName: "OpenCode",
    loginCommand: "opencode auth login",
  },
  grok: {
    displayName: "Grok",
    loginCommand: "grok login",
  },
  antigravity: {
    displayName: "Antigravity",
    loginCommand: "agy auth login",
  },
  muse: {
    displayName: "Muse Code",
    loginCommand: "muse login",
  },
  acp: {
    displayName: "Custom ACP",
    loginCommand: null,
  },
};

export function getProviderLoginHint(driver: string): ProviderLoginHint {
  return (
    BUILTIN_PROVIDER_LOGIN_HINTS[driver] ?? {
      displayName: driver,
      loginCommand: null,
    }
  );
}

export interface RuntimeModeWizardOption {
  readonly value: RuntimeMode;
  readonly label: string;
  readonly badge: string;
  readonly summary: string;
}

export const RUNTIME_MODE_WIZARD_OPTIONS: ReadonlyArray<RuntimeModeWizardOption> = [
  {
    value: "approval-required",
    label: "Supervised",
    badge: "Safest",
    summary: "Asks for your approval before editing files or running shell commands.",
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    badge: "Edits only",
    summary: "Edits workspace files freely and asks before running other commands.",
  },
  {
    value: "auto",
    label: "Auto",
    badge: "AI-reviewed",
    summary: "Lets the provider's built-in reviewer approve actions where supported.",
  },
  {
    value: "full-access",
    label: "Full access",
    badge: "Default",
    summary: "Runs commands and edits without prompts. Best for trusted sandboxes.",
  },
] as const;

export type ProviderReadinessBucket = "ready" | "needsAuth" | "needsAttention";

export interface WizardProviderItem {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly bucket: ProviderReadinessBucket;
  readonly installed: boolean;
  readonly authStatus: ServerProviderAuthStatus;
  readonly version: string | null;
  readonly loginCommand: string | null;
  readonly message: string | null;
}

export interface ProviderReadinessSummary {
  readonly ready: ReadonlyArray<WizardProviderItem>;
  readonly needsAuth: ReadonlyArray<WizardProviderItem>;
  readonly needsAttention: ReadonlyArray<WizardProviderItem>;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly hasAnyReady: boolean;
  readonly nextRecommendedAction: "ready" | "sign-in" | "install-provider";
}

export function classifyProviderReadiness(
  providers: ReadonlyArray<ServerProvider>,
): ProviderReadinessSummary {
  const ready: WizardProviderItem[] = [];
  const needsAuth: WizardProviderItem[] = [];
  const needsAttention: WizardProviderItem[] = [];
  let disabledCount = 0;

  for (const provider of providers) {
    if (!provider.enabled || provider.status === "disabled") {
      disabledCount += 1;
      continue;
    }

    const hint = getProviderLoginHint(provider.driver);
    const displayName = provider.displayName?.trim() || hint.displayName;
    const isReady = provider.status === "ready";
    const isNeedsAuth =
      !isReady && provider.installed && provider.auth.status === "unauthenticated";
    const bucket: ProviderReadinessBucket = isReady
      ? "ready"
      : isNeedsAuth
        ? "needsAuth"
        : "needsAttention";

    const item: WizardProviderItem = {
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName,
      bucket,
      installed: provider.installed,
      authStatus: provider.auth.status,
      version: provider.version,
      loginCommand: hint.loginCommand,
      message: provider.message ?? provider.unavailableReason ?? null,
    };

    if (bucket === "ready") {
      ready.push(item);
    } else if (bucket === "needsAuth") {
      needsAuth.push(item);
    } else {
      needsAttention.push(item);
    }
  }

  const enabledCount = ready.length + needsAuth.length + needsAttention.length;
  const hasAnyReady = ready.length > 0;
  const nextRecommendedAction: ProviderReadinessSummary["nextRecommendedAction"] = hasAnyReady
    ? "ready"
    : needsAuth.length > 0
      ? "sign-in"
      : "install-provider";

  return {
    ready,
    needsAuth,
    needsAttention,
    enabledCount,
    disabledCount,
    hasAnyReady,
    nextRecommendedAction,
  };
}

export type WizardStepState = "complete" | "current" | "upcoming";

export interface WizardStepDescriptor {
  readonly id: "providers" | "permissions" | "workspace";
  readonly number: 1 | 2 | 3;
  readonly label: string;
  readonly state: WizardStepState;
}

export function deriveWizardSteps(input: {
  readonly hasAnyReadyProvider: boolean;
  readonly hasConfirmedRuntimeMode: boolean;
  readonly hasProjects: boolean;
}): ReadonlyArray<WizardStepDescriptor> {
  const providersState: WizardStepState = input.hasAnyReadyProvider ? "complete" : "current";
  const permissionsState: WizardStepState = input.hasConfirmedRuntimeMode
    ? "complete"
    : input.hasAnyReadyProvider
      ? "current"
      : "upcoming";
  const workspaceState: WizardStepState = input.hasProjects
    ? "complete"
    : input.hasAnyReadyProvider && input.hasConfirmedRuntimeMode
      ? "current"
      : "upcoming";

  return [
    { id: "providers", number: 1, label: "Connect provider", state: providersState },
    { id: "permissions", number: 2, label: "Permissions", state: permissionsState },
    { id: "workspace", number: 3, label: "Add workspace", state: workspaceState },
  ];
}
