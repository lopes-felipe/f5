import {
  DEFAULT_RUNTIME_MODE,
  type ProviderInstanceId,
  type ProviderKind,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderAuthStatus,
} from "@t3tools/contracts";
import { runtimeModeCapabilities, runtimeModeUnsupportedReason } from "@t3tools/shared/runtimeMode";

import { isProviderSelectable } from "../chat/providerIconUtils";
import { RUNTIME_MODE_PRESENTATION } from "../chat/runtimeModePresentation";

const BUILTIN_DRIVER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
  cursor: "Cursor Agent",
  opencode: "OpenCode",
  grok: "Grok",
  antigravity: "Antigravity",
  muse: "Muse Code",
  pi: "Pi",
  acp: "Custom ACP",
};

const KNOWN_PROVIDER_KINDS: ReadonlySet<string> = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "grok",
  "antigravity",
  "muse",
  "pi",
  "acp",
]);

const CHECKING_PROVIDER_MESSAGE_RE = /has not been checked|checking .*availability/i;

const RUNTIME_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

function badgeForRuntimeMode(mode: RuntimeMode): string {
  if (mode === DEFAULT_RUNTIME_MODE) {
    return "Default";
  }
  switch (mode) {
    case "approval-required":
      return "Safest";
    case "auto-accept-edits":
      return "Edits only";
    case "auto":
      return "AI-reviewed";
    case "full-access":
      return "Unrestricted";
  }
}

export interface RuntimeModeWizardOption {
  readonly value: RuntimeMode;
  readonly label: string;
  readonly badge: string;
  readonly summary: string;
}

export const RUNTIME_MODE_WIZARD_OPTIONS: ReadonlyArray<RuntimeModeWizardOption> =
  RUNTIME_MODE_ORDER.map((mode) => ({
    value: mode,
    label: RUNTIME_MODE_PRESENTATION[mode].label,
    badge: badgeForRuntimeMode(mode),
    summary: RUNTIME_MODE_PRESENTATION[mode].description,
  }));

export type ProviderReadinessBucket = "ready" | "checking" | "needsAuth" | "needsAttention";

export interface WizardProviderItem {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly displayName: string;
  readonly bucket: ProviderReadinessBucket;
  readonly installed: boolean;
  readonly authStatus: ServerProviderAuthStatus;
  readonly authType: string | undefined;
  readonly hasCaveat: boolean;
  readonly authUnverified: boolean;
  readonly availableRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly version: string | null;
  readonly message: string | null;
}

export interface ProviderReadinessSummary {
  readonly ready: ReadonlyArray<WizardProviderItem>;
  readonly checking: ReadonlyArray<WizardProviderItem>;
  readonly needsAuth: ReadonlyArray<WizardProviderItem>;
  readonly needsAttention: ReadonlyArray<WizardProviderItem>;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly hasAnyReady: boolean;
}

function isCheckingProviderSnapshot(provider: ServerProvider): boolean {
  if (provider.status !== "warning") {
    return false;
  }
  const message = provider.message ?? "";
  return CHECKING_PROVIDER_MESSAGE_RE.test(message);
}

export function classifyProviderReadiness(
  providers: ReadonlyArray<ServerProvider>,
): ProviderReadinessSummary {
  const ready: WizardProviderItem[] = [];
  const checking: WizardProviderItem[] = [];
  const needsAuth: WizardProviderItem[] = [];
  const needsAttention: WizardProviderItem[] = [];
  let disabledCount = 0;

  for (const provider of providers) {
    if (!provider.enabled || provider.status === "disabled") {
      disabledCount += 1;
      continue;
    }

    const displayName =
      provider.displayName?.trim() ||
      BUILTIN_DRIVER_DISPLAY_NAMES[provider.driver] ||
      provider.driver;

    let bucket: ProviderReadinessBucket;
    if (isCheckingProviderSnapshot(provider)) {
      bucket = "checking";
    } else if (provider.installed && provider.auth.status === "unauthenticated") {
      bucket = "needsAuth";
    } else if (provider.installed && isProviderSelectable(provider)) {
      bucket = "ready";
    } else {
      bucket = "needsAttention";
    }

    const item: WizardProviderItem = {
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName,
      bucket,
      installed: provider.installed,
      authStatus: provider.auth.status,
      authType: provider.auth.type,
      hasCaveat: bucket === "ready" && provider.status === "warning",
      authUnverified: bucket === "ready" && provider.auth.status === "unknown",
      availableRuntimeModes: provider.availableRuntimeModes,
      version: provider.version,
      message: provider.message ?? provider.unavailableReason ?? null,
    };

    switch (bucket) {
      case "ready":
        ready.push(item);
        break;
      case "checking":
        checking.push(item);
        break;
      case "needsAuth":
        needsAuth.push(item);
        break;
      case "needsAttention":
        needsAttention.push(item);
        break;
    }
  }

  const enabledCount = ready.length + checking.length + needsAuth.length + needsAttention.length;

  return {
    ready,
    checking,
    needsAuth,
    needsAttention,
    enabledCount,
    disabledCount,
    hasAnyReady: ready.length > 0,
  };
}

export interface RuntimeModeCompatibilityResult {
  readonly status: "supported" | "partial" | "unsupported";
  readonly unsupportedProviders: ReadonlyArray<{
    readonly displayName: string;
    readonly reason: string;
  }>;
}

export function evaluateRuntimeModeCompatibility(
  mode: RuntimeMode,
  readyProviders: ReadonlyArray<
    Pick<WizardProviderItem, "driver" | "displayName" | "availableRuntimeModes">
  >,
): RuntimeModeCompatibilityResult {
  const checked = readyProviders.filter((provider) => KNOWN_PROVIDER_KINDS.has(provider.driver));
  if (checked.length === 0) {
    return { status: "supported", unsupportedProviders: [] };
  }

  const unsupportedProviders: Array<{ readonly displayName: string; readonly reason: string }> = [];
  for (const provider of checked) {
    const kind = provider.driver as ProviderKind;
    const capabilities = runtimeModeCapabilities(kind, provider.availableRuntimeModes);
    if (!capabilities.has(mode)) {
      const reason =
        runtimeModeUnsupportedReason(kind, mode, provider.availableRuntimeModes) ??
        `${mode} is not available for ${provider.displayName}.`;
      unsupportedProviders.push({ displayName: provider.displayName, reason });
    }
  }

  if (unsupportedProviders.length === 0) {
    return { status: "supported", unsupportedProviders };
  }
  if (unsupportedProviders.length === checked.length) {
    return { status: "unsupported", unsupportedProviders };
  }
  return { status: "partial", unsupportedProviders };
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
