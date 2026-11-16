import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";

/** App-wide provider overrides that predate per-instance configuration. */
export interface LegacyProviderOverrides {
  readonly binaryPath?: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly customModels?: ReadonlyArray<string>;
}

export type LegacyProviderOverrideField = keyof LegacyProviderOverrides;

/**
 * Copy legacy overrides into an instance config. A field the instance already
 * sets keeps its value and is reported in `skipped`; custom models are merged.
 * A value equal to the driver default (for example the `codex` binary that a
 * blank path decodes to) counts as unset, so it does not block the move.
 */
export function mergeLegacyProviderOverrides(
  instance: ProviderInstanceConfig,
  legacy: LegacyProviderOverrides,
): {
  readonly instance: ProviderInstanceConfig;
  readonly skipped: ReadonlyArray<LegacyProviderOverrideField>;
} {
  const config: Record<string, unknown> =
    instance.config !== null && typeof instance.config === "object"
      ? { ...(instance.config as Record<string, unknown>) }
      : {};
  const driverDefaults = (DEFAULT_UNIFIED_SETTINGS.providers as Record<string, unknown>)[
    instance.driver
  ] as Record<string, unknown> | undefined;
  const skipped: LegacyProviderOverrideField[] = [];
  for (const key of ["binaryPath", "homePath", "launchArgs"] as const) {
    const value = legacy[key]?.trim();
    if (!value) continue;
    const existing = typeof config[key] === "string" ? (config[key] as string).trim() : "";
    const fallback =
      typeof driverDefaults?.[key] === "string" ? (driverDefaults[key] as string).trim() : "";
    if (existing.length > 0 && existing !== fallback && existing !== value) {
      skipped.push(key);
      continue;
    }
    config[key] = value;
  }
  const legacyModels = (legacy.customModels ?? []).map((slug) => slug.trim()).filter(Boolean);
  if (legacyModels.length > 0) {
    const existing = Array.isArray(config.customModels)
      ? (config.customModels as ReadonlyArray<unknown>)
      : [];
    const existingSlugs = new Set(
      existing.map((model) =>
        typeof model === "string"
          ? model
          : model !== null && typeof model === "object" && "slug" in model
            ? String((model as { slug: unknown }).slug)
            : "",
      ),
    );
    config.customModels = [...existing, ...legacyModels.filter((slug) => !existingSlugs.has(slug))];
  }
  return { instance: { ...instance, config }, skipped };
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const legacyProviderDefaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const legacyProviderDefault = input.isDefault ? legacyProviderDefaults[input.driver] : undefined;
  return {
    ...(legacyProviderDefault !== undefined
      ? {
          providers: {
            ...input.settings.providers,
            [input.driver]: legacyProviderDefault,
          } as ServerSettings["providers"],
        }
      : {}),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}
