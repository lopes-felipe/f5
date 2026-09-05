import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { Effect, Option, Path, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createClaudeModelCapabilities,
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  normalizeModelSlug,
  supportsClaudeContextWindow,
} from "@t3tools/shared/model";
import {
  query as claudeQuery,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { compareCliVersions } from "../cliVersion.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import {
  resolveClaudeCliInvocation,
  resolveClaudeSdkExecutableOptions,
} from "../claudeSdkExecutable.ts";
import { AccountUsageReadError, accountUsageErrorCode } from "../../usage/accountUsageErrors.ts";
import { normalizeClaudeAccountUsage } from "../../usage/claudeAccountUsage.ts";
import { CommandNotFoundError } from "../../spawn/resolveCommand.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-opus-5"),
  },
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-fable-5"),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-sonnet-5"),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-opus-4-8"),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-opus-4-7"),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-opus-4-6"),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-opus-4-5"),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-sonnet-4-6"),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createClaudeModelCapabilities("claude-haiku-4-5"),
  },
];

const VERSION_GATED_CLAUDE_MODELS = [
  { slug: "claude-opus-5", name: "Claude Opus 5", minVersion: "2.1.220" },
  { slug: "claude-fable-5", name: "Claude Fable 5", minVersion: "2.1.170" },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5", minVersion: "2.1.170" },
  { slug: "claude-opus-4-8", name: "Claude Opus 4.8", minVersion: "2.1.154" },
  { slug: "claude-opus-4-7", name: "Claude Opus 4.7", minVersion: "2.1.111" },
] as const;

function isClaudeModelSupportedAtVersion(
  minVersion: string,
  version: string | null | undefined,
): boolean {
  return version ? compareCliVersions(version, minVersion) >= 0 : false;
}

function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!version) {
    return BUILT_IN_MODELS;
  }
  const unsupported = new Set<string>(
    VERSION_GATED_CLAUDE_MODELS.filter(
      (gate) => !isClaudeModelSupportedAtVersion(gate.minVersion, version),
    ).map((gate) => gate.slug),
  );
  return unsupported.size === 0
    ? BUILT_IN_MODELS
    : BUILT_IN_MODELS.filter((model) => !unsupported.has(model.slug));
}

function formatClaudeUpgradeMessage(version: string | null): string | undefined {
  if (!version) return undefined;
  const gate = VERSION_GATED_CLAUDE_MODELS.find(
    (candidate) => !isClaudeModelSupportedAtVersion(candidate.minVersion, version),
  );
  if (!gate) return undefined;
  return `Claude Code v${version} is too old for ${gate.name}. Upgrade to v${gate.minVersion} or newer to access it.`;
}

function isClaudeModelGatedOut(
  slug: string | null | undefined,
  version: string | null | undefined,
): boolean {
  if (!slug || !version) return false;
  const gate = VERSION_GATED_CLAUDE_MODELS.find((candidate) => candidate.slug === slug);
  return gate ? !isClaudeModelSupportedAtVersion(gate.minVersion, version) : false;
}

function getProviderClaudeModelsForVersion(
  version: string | null | undefined,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const filteredCustomModels = customModels.filter((candidate) => {
    const normalized = normalizeModelSlug(candidate, "claudeAgent");
    return !isClaudeModelGatedOut(normalized, version);
  });
  return providerModelsFromSettings(
    getBuiltInClaudeModelsForVersion(version),
    PROVIDER,
    filteredCustomModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
}

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = normalizeModelSlug(model, "claudeAgent");
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * Mirrors the mapping used when invoking the Claude Agent SDK
 * ({@link getEffectiveClaudeAgentEffort} in ClaudeAdapter): the Opus 4.7
 * capability `"xhigh"` is rewritten to the accepted CLI value `"max"`, and
 * `"ultrathink"` is filtered out because it is a prompt-prefix mode rather
 * than a CLI-effort value. Returns `undefined` when no flag should be passed.
 */
export function normalizeClaudeCliEffort(effort: string | null | undefined): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "xhigh") {
    return "max";
  }
  return effort;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  const model = normalizeModelSlug(modelSelection.model, "claudeAgent") ?? modelSelection.model;
  switch (getModelSelectionStringOptionValue(modelSelection, "contextWindow")) {
    case "1m":
      return supportsClaudeContextWindow(model) ? `${model}[1m]` : model;
    default:
      return model;
  }
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Run a prompt-free control query in the configured server authentication context.
 *
 * We pass a never-yielding AsyncIterable so no user message reaches stdin.
 * Initialization alone is local; usage control calls can contact the provider
 * and scan local transcripts. Always abort after the supplied operation.
 */
export function withClaudeProbeQuery<A>(
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  use: (query: ReturnType<typeof claudeQuery>) => Promise<A>,
  options: { readonly createQuery?: typeof claudeQuery; readonly cwd?: string } = {},
) {
  return Effect.suspend(() => {
    const abort = new AbortController();
    const cwd = options.cwd ?? process.cwd();
    return Effect.gen(function* () {
      const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
      return yield* Effect.tryPromise({
        try: async () => {
          const q = (options.createQuery ?? claudeQuery)({
            // Never yield: closing stdin before the control request can terminate the CLI.
            // oxlint-disable-next-line require-yield
            prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
              await waitForAbortSignal(abort.signal);
            })(),
            options: {
              persistSession: false,
              // Keep resolution inside tryPromise: Windows shim resolution throws synchronously.
              ...resolveClaudeSdkExecutableOptions(
                claudeSettings.binaryPath,
                claudeEnvironment,
                process.platform,
                cwd,
              ),
              cwd,
              abortController: abort,
              settingSources: ["user", "project", "local"],
              allowedTools: [],
              env: claudeEnvironment,
              stderr: () => {},
            },
          });
          return await use(q);
        },
        catch: (error) => new AccountUsageReadError(accountUsageErrorCode(error)),
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!abort.signal.aborted) abort.abort();
        }),
      ),
      Effect.timeoutOption(8_000),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(new AccountUsageReadError("timeout")),
      ),
    );
  });
}

export function claudeCapabilitiesFromInitialization(
  init: Awaited<ReturnType<ReturnType<typeof claudeQuery>["initializationResult"]>>,
): ClaudeCapabilitiesProbe {
  const account = init.account;
  return {
    email: account?.email,
    subscriptionType: account?.subscriptionType,
    tokenSource: account?.tokenSource,
    slashCommands: parseClaudeInitializationCommands(init.commands),
  };
}

const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly createQuery?: typeof claudeQuery; readonly cwd?: string } = {},
) =>
  withClaudeProbeQuery(
    claudeSettings,
    environment,
    async (q) => claudeCapabilitiesFromInitialization(await q.initializationResult()),
    options,
  ).pipe(
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
  );

export const probeClaudeAccountUsage = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  options: {
    readonly createQuery?: typeof claudeQuery;
    readonly cwd?: string;
    readonly onCapabilities?: (value: ClaudeCapabilitiesProbe) => Promise<void>;
  } = {},
) =>
  withClaudeProbeQuery(
    claudeSettings,
    environment,
    async (q) => {
      const capabilities = claudeCapabilitiesFromInitialization(await q.initializationResult());
      await options.onCapabilities?.(capabilities);
      const read = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof read !== "function") throw new AccountUsageReadError("unsupported");
      let response: unknown;
      try {
        response = await read.call(q);
      } catch (error) {
        // Only a rejection from this operation can prove unsupported usage RPCs.
        if (
          error instanceof Error &&
          /unknown (request|subtype)|unsupported|not supported|unrecognized/i.test(error.message)
        )
          throw new AccountUsageReadError("unsupported");
        throw error;
      }
      return normalizeClaudeAccountUsage(response);
    },
    options,
  );

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const invocation = yield* Effect.try({
    try: () => resolveClaudeCliInvocation(claudeSettings.binaryPath, args, claudeEnvironment),
    catch: (cause) =>
      cause instanceof CommandNotFoundError
        ? cause
        : new CommandNotFoundError(claudeSettings.binaryPath, String(cause)),
  });
  const command = ChildProcess.make(invocation.file, [...invocation.args], {
    env: claudeEnvironment,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const checkedAt = new Date().toISOString();
  const unknownVersionModels = getProviderClaudeModelsForVersion(null, claudeSettings.customModels);

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: unknownVersionModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(claudeSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: unknownVersionModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: unknownVersionModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  const modelsForParsedVersion = getProviderClaudeModelsForVersion(
    parsedVersion,
    claudeSettings.customModels,
  );
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: modelsForParsedVersion,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const upgradeMessage = formatClaudeUpgradeMessage(parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    const authenticationWarning =
      "Could not verify Claude authentication status from initialization result.";
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: modelsForParsedVersion,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: [authenticationWarning, upgradeMessage].filter(Boolean).join(" "),
      },
    });
  }

  const authMetadata = claudeAuthMetadata({
    subscriptionType: capabilities.subscriptionType,
    authMethod: capabilities.tokenSource,
  });
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models: modelsForParsedVersion,
    slashCommands: dedupedSlashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(upgradeMessage ? { message: upgradeMessage } : {}),
    },
  });
});

export const makePendingClaudeProvider = (claudeSettings: ClaudeSettings): ServerProviderDraft => {
  const checkedAt = new Date().toISOString();
  const models = getProviderClaudeModelsForVersion(null, claudeSettings.customModels);

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Claude provider status has not been checked in this session yet.",
    },
  });
};

export { probeClaudeCapabilities };
