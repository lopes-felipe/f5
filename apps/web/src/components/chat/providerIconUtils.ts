import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { ClaudeAI, CursorIcon, Gemini, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { PROVIDER_OPTIONS, type ProviderPickerKind } from "../../session-logic";

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};
export type ModelPickerModelOption = ModelEsque;

export const PROVIDER_LABEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
};

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<string, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
};

export const PROVIDER_ICON_BY_PICKER_KIND: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
  opencode: OpenCodeIcon,
};

export const COMING_SOON_PROVIDER_OPTIONS = [
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
  providers: ReadonlyArray<ServerProvider> | undefined,
  providerKind: ProviderKind,
): ServerProvider | null {
  const driverKind = ProviderDriverKind.make(providerKind);
  const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
  return (
    providers?.find((provider) => provider.instanceId === defaultInstanceId) ??
    providers?.find((provider) => provider.driver === driverKind) ??
    null
  );
}

export function isProviderSelectable(status: ServerProvider | null): boolean {
  return (
    !status ||
    (status.enabled &&
      status.availability !== "unavailable" &&
      status.status !== "error" &&
      status.status !== "disabled")
  );
}

export function providerDisabledReason(status: ServerProvider | null): string | null {
  if (isProviderSelectable(status)) {
    return null;
  }
  return status?.message ?? status?.unavailableReason ?? "Provider unavailable";
}

export function describeProviderStatus(label: string, status: ServerProvider | null): string {
  if (!status) {
    return label;
  }
  if (isProviderSelectable(status)) {
    return status.message ? `${label}. ${status.message}` : label;
  }
  const message = status.message ?? status.unavailableReason;
  return message ? `${label}. ${message}` : `${label} is unavailable.`;
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
