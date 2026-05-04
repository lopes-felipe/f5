import { type ProviderKind, type ServerProviderStatus } from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, Gemini, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { PROVIDER_OPTIONS, type ProviderPickerKind } from "../../session-logic";

export type ModelPickerModelOption = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};

export const PROVIDER_LABEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
};

export const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
};

export const PROVIDER_ICON_BY_PICKER_KIND: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
};

export const COMING_SOON_PROVIDER_OPTIONS = [
  { id: "opencode", label: "OpenCode", icon: OpenCodeIcon },
  { id: "gemini", label: "Gemini", icon: Gemini },
] as const;

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
export const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);

export function providerIconClassName(provider: ProviderKind | ProviderPickerKind): string {
  return provider === "claudeAgent" ? "text-[#d97757]" : "text-muted-foreground/75";
}

export function findProviderStatus(
  providers: ReadonlyArray<ServerProviderStatus> | undefined,
  providerKind: ProviderKind,
): ServerProviderStatus | null {
  return providers?.find((provider) => provider.provider === providerKind) ?? null;
}

export function isProviderSelectable(status: ServerProviderStatus | null): boolean {
  return !status || (status.available && status.status !== "error");
}

export function providerDisabledReason(status: ServerProviderStatus | null): string | null {
  if (isProviderSelectable(status)) {
    return null;
  }
  return status?.message ?? "Provider unavailable";
}

export function describeProviderStatus(label: string, status: ServerProviderStatus | null): string {
  if (!status) {
    return label;
  }
  if (isProviderSelectable(status)) {
    return status.message ? `${label}. ${status.message}` : label;
  }
  return status.message ? `${label}. ${status.message}` : `${label} is unavailable.`;
}

export function getProviderLabel(provider: ProviderKind, model?: ModelPickerModelOption): string {
  const providerLabel = PROVIDER_LABEL_BY_PROVIDER[provider];
  return model?.subProvider ? `${providerLabel} · ${model.subProvider}` : providerLabel;
}

export function getDisplayModelName(
  model: ModelPickerModelOption,
  options?: { preferShortName?: boolean },
): string {
  if (options?.preferShortName && model.shortName) {
    return model.shortName;
  }
  return model.name;
}

export function getTriggerDisplayModelName(model: ModelPickerModelOption): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelPickerModelOption): string {
  const title = getTriggerDisplayModelName(model);
  return model.subProvider ? `${model.subProvider} · ${title}` : title;
}
