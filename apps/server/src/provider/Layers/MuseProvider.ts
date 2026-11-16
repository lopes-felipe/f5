/**
 * Muse Code provider snapshot: install probe (`muse --version`), then a
 * short-lived `muse serve` for the model catalog and sign-in state.
 *
 * F5 never installs Muse Code or manages its sign-in; the snapshot only
 * reports state and the steps the user takes in a terminal.
 *
 * @module provider/Layers/MuseProvider
 */
import { tmpdir } from "node:os";

import type { ModelCatalogEntry, ModelListResult } from "@muse-code/sdk/dist/src/msp.js";
import {
  MUSE_REASONING_EFFORT_OPTIONS,
  type CustomModelSetting,
  type ModelCapabilities,
  type MuseSettings,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { MUSE_SERVE_ARGS } from "@t3tools/shared/museProtocolManifest";
import { Effect, Option, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveMuseInvocation } from "../msp/MusePaths.ts";
import {
  describeMspError,
  MuseCliError,
  mspErrorKind,
  openMspHost,
} from "../msp/MspSessionRuntime.ts";
import { makeMspTransport } from "../msp/MspTransport.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const HOST_PROBE_TIMEOUT_MS = 10_000;

export const MUSE_INSTALL_HINT = "curl -fsSL https://dev.meta.ai/install.sh | bash";
export const MUSE_SIGN_IN_HINT =
  "Run `muse` once in a terminal to sign in, use `muse auth set`, or set META_API_KEY on this instance.";
export const MUSE_API_KEY_MASK_NOTE =
  "META_API_KEY is set, so it takes precedence over any browser sign-in stored by Muse Code.";

const MUSE_PRESENTATION = {
  displayName: "Muse Code",
  badgeLabel: "Early Access",
  // MSP 1.4 cannot switch a running session to a read-only profile.
  showInteractionModeToggle: false,
} as const;

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };

function effortCapabilities(
  supported: ReadonlyArray<string> = MUSE_REASONING_EFFORT_OPTIONS,
): ModelCapabilities {
  const options = MUSE_REASONING_EFFORT_OPTIONS.filter((effort) => supported.includes(effort));
  return createModelCapabilities({
    optionDescriptors:
      options.length > 0
        ? [
            buildSelectOptionDescriptor({
              id: "reasoningEffort",
              label: "Reasoning",
              options: options.map((value) => ({
                value,
                label: EFFORT_LABELS[value] ?? value,
                ...(value === "high" ? { isDefault: true } : {}),
              })),
            }),
          ]
        : [],
  });
}

const MUSE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    isCustom: false,
    capabilities: effortCapabilities(),
  },
];

function museModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = MUSE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    builtInModels,
    "muse",
    customModels ?? [],
    effortCapabilities(),
  );
}

/** `model/list` overrides the built-ins; custom models are appended. */
export function museModelsFromCatalog(
  entries: ReadonlyArray<ModelCatalogEntry>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const slug = entry.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const variants = Array.isArray(entry.variants)
      ? entry.variants
      : entry.reasoningEffortVariants?.map((variant) => variant.tier);
    return [
      {
        slug,
        name: entry.displayLabel.trim() || slug,
        isCustom: false,
        capabilities: { ...effortCapabilities(variants), source: "reported" as const },
      },
    ];
  });
}

export interface MuseHostProbe {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly signedIn: boolean | undefined;
  readonly fingerprintWarning: string | undefined;
}

/** Auth label and status from the environment and the host's answers. */
export function museAuthStatus(input: {
  readonly apiKeySet: boolean;
  readonly signedIn: boolean | undefined;
}): ServerProviderAuth {
  if (input.apiKeySet) {
    return { status: "authenticated", type: "apiKey", label: "API key (environment)" };
  }
  if (input.signedIn === true) return { status: "authenticated", label: "Signed in" };
  if (input.signedIn === false) return { status: "unauthenticated", label: "Not signed in" };
  return { status: "unknown" };
}

export function buildInitialMuseProviderSnapshot(settings: MuseSettings): ServerProviderDraft {
  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: new Date().toISOString(),
    models: museModelsFromSettings(settings.customModels),
    probe: settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking Muse Code availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Muse Code is disabled in F5 settings.",
        },
  });
}

/** A short-lived host: `model/list` and `usage/read`, then close. */
const probeMuseHost = (settings: MuseSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const transport = yield* makeMspTransport({
      binaryPath: settings.binaryPath || "muse",
      args: MUSE_SERVE_ARGS,
      cwd: tmpdir(),
      environment,
    });
    return yield* Effect.tryPromise({
      try: async (): Promise<MuseHostProbe> => {
        const host = await openMspHost({ transport: transport.transport, clientVersion: "0.0.0" });
        try {
          const catalog = (await host.request("model/list", {})) as unknown as ModelListResult;
          let signedIn: boolean | undefined;
          try {
            const usage = await host.request("usage/read", {});
            signedIn = usage.usage !== undefined ? true : undefined;
          } catch (error) {
            const kind = mspErrorKind(error) ?? "";
            signedIn = /auth|credential|sign/i.test(`${kind} ${describeMspError(error)}`)
              ? false
              : undefined;
          }
          return {
            models: museModelsFromCatalog(catalog.models ?? []),
            signedIn,
            fingerprintWarning: host.fingerprintWarning?.message,
          };
        } finally {
          await host.close().catch(() => undefined);
        }
      },
      catch: (cause) => new MuseCliError({ message: describeMspError(cause), cause }),
    });
  }).pipe(Effect.scoped);

export const checkMuseProviderStatus = Effect.fn("checkMuseProviderStatus")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = new Date().toISOString();
  const fallbackModels = museModelsFromSettings(settings.customModels);
  if (!settings.enabled) return buildInitialMuseProviderSnapshot(settings);

  const command = settings.binaryPath || "muse";
  const versionResult = yield* Effect.gen(function* () {
    const invocation = yield* resolveMuseInvocation(command, ["--version"], environment, tmpdir());
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(invocation.file, [...invocation.args], { env: environment }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error =
      versionResult.failure instanceof Error
        ? versionResult.failure
        : new Error(String(versionResult.failure));
    const missing = isCommandMissingCause(error);
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Muse Code CLI (\`muse\`) is not installed or not on PATH. Install it in a terminal: \`${MUSE_INSTALL_HINT}\`. F5 does not run the installer.`
          : `Failed to run the Muse Code CLI: ${error.message}`,
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Muse Code CLI timed out while running `muse --version`.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    const detail = detailFromResult(versionOutput);
    return buildServerProvider({
      presentation: MUSE_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Muse Code CLI is installed but failed to run.${detail ? ` ${detail}` : ""}`,
      },
    });
  }

  const apiKeySet = Boolean(environment.META_API_KEY?.trim());
  const hostResult = yield* probeMuseHost(settings, environment).pipe(
    Effect.timeoutOption(HOST_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const probe =
    Result.isSuccess(hostResult) && Option.isSome(hostResult.success)
      ? hostResult.success.value
      : undefined;
  const auth = museAuthStatus({ apiKeySet, signedIn: probe?.signedIn });
  const notes = [
    probe?.fingerprintWarning
      ? "Untested Muse Code protocol: this CLI's schema differs from the one F5 was built against."
      : undefined,
    apiKeySet ? MUSE_API_KEY_MASK_NOTE : undefined,
    auth.status !== "authenticated" ? MUSE_SIGN_IN_HINT : undefined,
    !probe
      ? `Muse Code is installed, but the model and sign-in check did not complete${
          Result.isFailure(hostResult) ? `: ${String(hostResult.failure.message)}` : ""
        }. Refresh to retry.`
      : undefined,
  ].filter((note): note is string => note !== undefined);

  return buildServerProvider({
    presentation: MUSE_PRESENTATION,
    enabled: true,
    checkedAt,
    models: probe?.models.length
      ? museModelsFromSettings(settings.customModels, probe.models)
      : fallbackModels,
    probe: {
      installed: true,
      version,
      status:
        auth.status === "authenticated" && probe && !probe.fingerprintWarning ? "ready" : "warning",
      auth,
      ...(notes.length > 0 ? { message: notes.join(" ") } : {}),
    },
  });
});
