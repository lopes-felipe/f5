import type {
  AntigravitySettings,
  ProviderOptionDescriptor,
  RuntimeMode,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect } from "effect";
import {
  AntigravityInstallation,
  AntigravityUpdateRequiredError,
} from "../AntigravityInstallation.ts";
import { antigravityProfileDirectory } from "../acp/AntigravityAcpSupport.ts";
import type { AntigravityThinkingLevels } from "../acp/AntigravityAcpSupport.ts";
import {
  antigravityAuthConfig,
  antigravityReadiness,
  hasAntigravityOAuthToken,
} from "../antigravityAuthSupport.ts";
import { antigravityPrivateFormatGate } from "../antigravityPrivateFormats.ts";
import { resolveAntigravityReleaseAsset } from "../antigravityRelease.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";

/** Picker order: Orchestrator first, then Carbon, then Neon, then the rest in native order. */
function antigravityModelRank(slug: string): number {
  const id = slug.toLowerCase();
  if (id.includes("orchestrator")) return 0;
  if (id.includes("carbon")) return 1;
  if (id.includes("neon")) return 2;
  return 3;
}

/** The `thinking` select for one model, built from its observed `thought_level` option. */
export function antigravityThinkingDescriptor(
  thinking: AntigravityThinkingLevels,
): ProviderOptionDescriptor | undefined {
  const options = thinking.levels.flatMap((level) => {
    const id = level.value.trim();
    if (!id) return [];
    const label = level.name.trim() || id;
    return [
      {
        id,
        label: label.charAt(0).toUpperCase() + label.slice(1),
        ...(id === thinking.defaultLevel ? { isDefault: true } : {}),
      },
    ];
  });
  if (options.length === 0) return undefined;
  return {
    id: "thinking",
    label: "Thinking",
    type: "select",
    options,
    ...(thinking.defaultLevel && options.some((option) => option.id === thinking.defaultLevel)
      ? { currentValue: thinking.defaultLevel }
      : {}),
  };
}

/** Read a model's levels back from a published descriptor (catalog hydration). */
export function antigravityThinkingFromModel(
  model: ServerProviderModel,
): AntigravityThinkingLevels | null | undefined {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === "thinking" && candidate.type === "select",
  );
  if (!descriptor || descriptor.type !== "select") return undefined;
  return {
    levels: descriptor.options.map((option) => ({ value: option.id, name: option.label })),
    defaultLevel:
      descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id,
  };
}

/**
 * Keep account model IDs unique, distinguish repeated picker labels, order the picker and attach
 * a thinking control to models whose levels were observed. Models never observed, and models with
 * no `thought_level` option (Orchestrator), show no control.
 */
export function buildAntigravityModels(
  choices: ReadonlyArray<{ readonly value: string; readonly name: string }>,
  thinkingByModel: ReadonlyMap<string, AntigravityThinkingLevels | null> = new Map(),
): ServerProviderModel[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  const models = choices.flatMap((choice) => {
    if (!choice.value.trim() || ids.has(choice.value)) return [];
    ids.add(choice.value);
    const baseName = choice.name.trim() ? choice.name : choice.value;
    const name = names.has(baseName) ? `${baseName} (${choice.value})` : baseName;
    names.add(baseName);
    const thinking = thinkingByModel.get(choice.value);
    const descriptor = thinking ? antigravityThinkingDescriptor(thinking) : undefined;
    return [
      {
        slug: choice.value,
        name,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: descriptor ? [descriptor] : [],
        }),
      },
    ];
  });
  return models
    .map((model, index) => ({ model, index }))
    .toSorted(
      (left, right) =>
        antigravityModelRank(left.model.slug) - antigravityModelRank(right.model.slug) ||
        left.index - right.index,
    )
    .map(({ model }) => model);
}

/** Kept for callers that only need the Google-account token check. */
export async function hasAntigravityAccount(
  stateDir: string,
  instanceId: string,
): Promise<boolean> {
  return hasAntigravityOAuthToken(antigravityProfileDirectory(stateDir, instanceId));
}

export interface AntigravityStatusContext {
  readonly keyUnavailable?: boolean;
  readonly availableRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly modelCatalog?: ServerProvider["modelCatalog"];
  /** Driver-owned health lines (catalog freshness, redacted discovery failure class). */
  readonly healthDetails?: NonNullable<ServerProvider["healthDetails"]>;
}

/** Runtime source, version and private-format reader gate for the provider card. */
export function antigravityRuntimeHealthDetails(
  version: string | null,
  pinnedVersion: string | null | undefined = resolveAntigravityReleaseAsset(
    process.platform,
    process.arch,
  )?.version,
): NonNullable<ServerProvider["healthDetails"]> {
  if (!version) return [];
  const gate = antigravityPrivateFormatGate(version);
  return [
    {
      label: "Runtime",
      value:
        version === pinnedVersion
          ? `Managed ${version} (bundled with F5)`
          : `Managed ${version} (installed update)`,
    },
    {
      label: "Native readers",
      value: gate.enabled ? `On, certified for ${gate.version}` : `Off. ${gate.reason}`,
    },
  ];
}

export const checkAntigravityProviderStatus = (
  settings: AntigravitySettings,
  stateDir: string,
  instanceId: string,
  discoveredModels?: ReadonlyArray<ServerProviderModel>,
  context: AntigravityStatusContext = {},
) =>
  Effect.promise(async () => {
    const capabilities = createModelCapabilities({ optionDescriptors: [] });
    const models = providerModelsFromSettings(
      discoveredModels?.length
        ? discoveredModels
        : [
            {
              slug: "antigravity-default",
              name: "Antigravity Default",
              isCustom: false,
              capabilities,
            },
          ],
      "antigravity",
      settings.customModels,
      capabilities,
    );
    // A status refresh is a local read. It never installs, starts ACP, or prompts for login.
    let installed = false;
    let version: string | null = null;
    let installationMessage: string | undefined;
    const auth = antigravityAuthConfig(settings);
    let readiness: Awaited<ReturnType<typeof antigravityReadiness>> | undefined;
    if (settings.enabled) {
      try {
        const executable = await new AntigravityInstallation(stateDir).resolve();
        installed = true;
        version = executable.version;
      } catch (error) {
        if (error instanceof AntigravityUpdateRequiredError) {
          version = error.installedVersion;
          installationMessage = error.message;
        }
      }
      if (installed)
        readiness = await antigravityReadiness({
          profileDirectory: antigravityProfileDirectory(stateDir, instanceId),
          auth,
          ...(context.keyUnavailable ? { keyUnavailable: true } : {}),
        });
    }
    const authenticated = readiness?.ready === true;
    const snapshot = buildServerProvider({
      // The plan toggle drives native Plan mode; turns fail closed when a session lacks it.
      presentation: { displayName: "Antigravity", showInteractionModeToggle: true },
      enabled: settings.enabled,
      checkedAt: new Date().toISOString(),
      models,
      ...(context.modelCatalog ? { modelCatalog: context.modelCatalog } : {}),
      probe: {
        installed,
        version,
        status: authenticated ? "ready" : "warning",
        auth: {
          status: authenticated ? "authenticated" : "unauthenticated",
          type: auth.authMethod,
          label:
            readiness?.authLabel ??
            (auth.authMethod === "gemini-api-key" ? "Gemini API key" : "Google account"),
        },
        ...(!settings.enabled
          ? { message: "Antigravity is disabled." }
          : !installed
            ? { message: installationMessage ?? "Install Antigravity in Settings to get started." }
            : !authenticated
              ? { message: readiness?.message ?? "Sign in to Antigravity in Settings." }
              : {}),
      },
    });
    const healthDetails = settings.enabled
      ? [
          ...(installed ? antigravityRuntimeHealthDetails(version) : []),
          ...(context.healthDetails ?? []),
        ]
      : [];
    return {
      ...snapshot,
      ...(context.availableRuntimeModes
        ? { availableRuntimeModes: [...context.availableRuntimeModes] }
        : {}),
      ...(healthDetails.length > 0 ? { healthDetails } : {}),
    };
  });
