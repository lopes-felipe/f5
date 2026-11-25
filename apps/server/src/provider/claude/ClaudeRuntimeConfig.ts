import { createClaudeModelCapabilities } from "@t3tools/shared/model";
import { normalizeOptionalString } from "../claudeToolPresentation.ts";
import { claudeThinkingConfig, type ClaudeThinkingResolution } from "../claudeProviderOptions.ts";
import { randomUUID } from "node:crypto";
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */

import { type SettingSource, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClaudeCodeEffort,
  type ModelCapabilities,
  type ModelSelection,
  type ProviderStartOptions,
  ProviderInstanceId,
  type ProviderModelOptions,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  claudeModelOptionsToProviderOptionSelections,
  createModelSelection,
  getClaudeContextWindowTokens,
  getEffectiveClaudeCodeEffort,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeClaudeContextWindow,
  normalizeModelSlug,
  resolveModelCapabilities,
  resolveReasoningEffortForProvider,
  resolveClaudeModelEffort,
  resolveSupportedEffort,
  supportsClaudeContextWindow,
  claudeModelSupportsAdaptiveThinking,
} from "@t3tools/shared/model";
import { Effect, Exit, FileSystem, Queue } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { buildProviderChildProcessEnv } from "../../providerProcessEnv.ts";
import {
  fetchAnthropicModelContextWindowCatalog,
  lookupModelContextWindowTokens,
  readClaudeModelContextWindowCatalog,
} from "../modelContextWindowMetadata.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterSendTurnInput } from "../Services/ProviderAdapter.ts";
import { appendProviderAttachmentRuntimeContext } from "../attachmentRuntimeContext.ts";
import { pdfDocuments } from "../pdfDocuments.ts";
import { resolveClaudeApiModelId } from "../Layers/ClaudeProvider.ts";

import {
  PROVIDER,
  type ClaudeContextWindow,
  type ClaudeSdkEffort,
  type ClaudeSessionContext,
  type PromptQueueItem,
} from "./ClaudeTypes.ts";
import { toMessage } from "./ClaudeResumeRecovery.ts";

export function makeClaudePromptInput(
  promptQueue: Queue.Queue<PromptQueueItem>,
): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: async (): Promise<IteratorResult<SDKUserMessage>> => {
          while (true) {
            const exit = await Effect.runPromise(Effect.exit(Queue.take(promptQueue)));
            if (Exit.isFailure(exit)) {
              return {
                done: true,
                value: undefined,
              };
            }

            if (exit.value.type === "terminate") {
              return {
                done: true,
                value: undefined,
              };
            }

            return {
              done: false,
              value: exit.value.message,
            };
          }
        },
        return: async () => ({
          done: true,
          value: undefined,
        }),
      };
    },
  };
}

export function getClaudeSessionModel(context: ClaudeSessionContext): string | undefined {
  return (
    normalizeOptionalString(context.configuredBase.model) ??
    normalizeOptionalString(context.session.model)
  );
}

export function claudeContextWindowKey(model: string): string {
  return normalizeModelSlug(model, "claudeAgent") ?? model;
}

export function getConfiguredClaudeContextWindow(
  config: Record<string, unknown>,
): ClaudeContextWindow | undefined {
  const value = config.context_window;
  return normalizeClaudeContextWindow(typeof value === "string" ? value : undefined);
}

export function emittedModelContextWindowTokens(context: ClaudeSessionContext): number | undefined {
  return getClaudeSessionModel(context) === undefined
    ? undefined
    : context.modelContextWindowTokens;
}

export function getClaudeModelSelectionForInstance(input: {
  readonly modelSelection?: ModelSelection | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}): ModelSelection | undefined {
  if (!input.modelSelection) {
    return undefined;
  }
  const boundInstanceId = input.providerInstanceId ?? ProviderInstanceId.make(PROVIDER);
  return input.modelSelection.instanceId === boundInstanceId ? input.modelSelection : undefined;
}

export function resolveClaudeRuntimeModelSelection(input: {
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly model?: string | undefined;
  readonly modelOptions?: ProviderModelOptions | undefined;
  readonly modelSelection?: ModelSelection | undefined;
  readonly fallbackModel?: string | undefined;
  readonly fallbackContextWindow?: ClaudeContextWindow | undefined;
}): {
  readonly baseModel?: string;
  readonly apiModel?: string;
  readonly options?: NonNullable<ModelSelection["options"]>;
  readonly contextWindow?: ClaudeContextWindow;
  readonly contextWindowTokens?: number;
} {
  const providerInstanceId = input.providerInstanceId ?? ProviderInstanceId.make(PROVIDER);
  const matchingModelSelection = getClaudeModelSelectionForInstance({
    modelSelection: input.modelSelection,
    providerInstanceId,
  });
  const rawBaseModel = matchingModelSelection?.model ?? input.model ?? input.fallbackModel;
  if (!rawBaseModel) {
    return {};
  }
  const baseModel = normalizeModelSlug(rawBaseModel, "claudeAgent") ?? rawBaseModel;

  const options =
    matchingModelSelection?.options ??
    claudeModelOptionsToProviderOptionSelections(input.modelOptions?.claudeAgent, baseModel);
  const supportsContextWindow = supportsClaudeContextWindow(baseModel);
  const selectedContextWindow = supportsContextWindow
    ? normalizeClaudeContextWindow(getProviderOptionStringSelectionValue(options, "contextWindow"))
    : undefined;
  const contextWindow = normalizeClaudeContextWindow(
    selectedContextWindow ??
      (supportsContextWindow ? (input.fallbackContextWindow ?? "200k") : undefined),
  );
  const contextWindowTokens = contextWindow
    ? getClaudeContextWindowTokens(contextWindow)
    : undefined;
  const effectiveOptions = [
    ...(options?.filter((option) => option.id !== "contextWindow") ?? []),
    ...(contextWindow ? [{ id: "contextWindow", value: contextWindow } as const] : []),
  ];
  const selection = createModelSelection(
    providerInstanceId,
    baseModel,
    effectiveOptions.length > 0 ? effectiveOptions : undefined,
  );
  return {
    baseModel,
    apiModel: resolveClaudeApiModelId(selection),
    ...(effectiveOptions.length > 0 ? { options: effectiveOptions } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

/** Looks up executable-reported capabilities for a model slug, when the instance has them. */

export function resolveClaudeRuntimeTraits(
  selection: ReturnType<typeof resolveClaudeRuntimeModelSelection>,
  fallbackModel?: string,
  reported?: ModelCapabilities,
): {
  readonly selectedModel?: string;
  readonly effectiveEffort?: ClaudeSdkEffort;
  readonly fastMode: boolean;
  readonly ultracode?: boolean;
  readonly thinking?: boolean;
} {
  const selectedModel = selection.baseModel ?? fallbackModel;
  if (!selectedModel) {
    return {
      fastMode: false,
    };
  }

  // Shared with the composer so the UI never offers what execution drops.
  const capabilities = resolveModelCapabilities("claudeAgent", selectedModel, reported);
  const legacyUltracode =
    getProviderOptionStringSelectionValue(selection.options, "effort") === "ultracode";
  const ultracode =
    (reported ?? createClaudeModelCapabilities(selectedModel)).optionDescriptors?.some(
      (descriptor) => descriptor.id === "ultracode",
    ) === true &&
    (getProviderOptionBooleanSelectionValue(selection.options, "ultracode") ?? legacyUltracode);
  const requestedEffort = resolveReasoningEffortForProvider(
    "claudeAgent",
    legacyUltracode
      ? "xhigh"
      : (getProviderOptionStringSelectionValue(selection.options, "effort") ?? null),
  );
  // An unsupported explicit effort is dropped rather than replaced by the default.
  const effort = requestedEffort
    ? resolveClaudeModelEffort(selectedModel, requestedEffort, reported)
    : ((capabilities.defaultEffort as ClaudeCodeEffort | undefined) ?? null);
  const fastMode =
    getProviderOptionBooleanSelectionValue(selection.options, "fastMode") === true &&
    capabilities.supportsFastMode;
  const thinkingSelection = getProviderOptionBooleanSelectionValue(selection.options, "thinking");
  const thinking =
    typeof thinkingSelection === "boolean" && capabilities.supportsThinkingToggle
      ? thinkingSelection
      : undefined;
  const effectiveEffort = getEffectiveClaudeCodeEffort(effort);

  return {
    selectedModel,
    ...(effectiveEffort ? { effectiveEffort } : {}),
    fastMode,
    ultracode,
    ...(typeof thinking === "boolean" ? { thinking } : {}),
  };
}

export function withClaudeRuntimeSelectionConfig(
  config: Record<string, unknown>,
  selection: {
    readonly baseModel?: string;
    readonly contextWindow?: ClaudeContextWindow;
  },
): Record<string, unknown> {
  const { context_window: _discardedContextWindow, ...rest } = config;
  return {
    ...rest,
    ...(selection.baseModel ? { model: selection.baseModel } : {}),
    ...(selection.contextWindow ? { context_window: selection.contextWindow } : {}),
  };
}

export function claudeRuntimeSettings(traits: {
  readonly fastMode: boolean;
  readonly ultracode?: boolean | undefined;
  readonly thinking?: boolean;
}) {
  return {
    ...(traits.ultracode ? { ultracode: true } : {}),
    ...(traits.fastMode ? { fastMode: true } : {}),
    ...(typeof traits.thinking === "boolean" ? { alwaysThinkingEnabled: traits.thinking } : {}),
  };
}

/**
 * Launch-time thinking for every SDK path. The per-turn toggle (`traits.thinking`)
 * also feeds `alwaysThinkingEnabled` through `claudeRuntimeSettings`, which the
 * resolver keeps consistent with the `thinking` option.
 */
export function resolveClaudeLaunchThinking(
  providerOptions: ProviderStartOptions["claudeAgent"] | undefined,
  traits: { readonly thinking?: boolean } | undefined,
  model: string | undefined,
  reported?: ModelCapabilities,
): ClaudeThinkingResolution {
  return claudeThinkingConfig({
    toggle: traits?.thinking,
    typed: providerOptions?.thinking,
    legacyMaxThinkingTokens: providerOptions?.maxThinkingTokens,
    supportsAdaptive: reported
      ? resolveModelCapabilities("claudeAgent", model, reported).supportsAdaptiveThinking
      : claudeModelSupportsAdaptiveThinking(model),
    model,
  });
}

/**
 * Claude 5 omits thinking text unless summaries are requested, and the SDK
 * only overrides the install default when the setting is explicit. A typed
 * `display` decides; then the user's own Claude setting (left to apply as is);
 * otherwise summaries are on. Disabled thinking needs no setting.
 */
export function claudeShowThinkingSummaries(
  thinking: ClaudeThinkingResolution["thinking"],
  userSetting?: boolean,
): boolean | undefined {
  if (thinking?.type === "disabled") return undefined;
  if (thinking?.display) return thinking.display === "summarized";
  return userSetting === undefined ? true : undefined;
}

export function claudeThinkingConfiguredFields(resolution: ClaudeThinkingResolution) {
  return {
    ...(resolution.thinking ? { thinking: resolution.thinking } : {}),
    thinkingSource: resolution.source,
    ...(resolution.fallback ? { thinkingFallback: resolution.fallback } : {}),
  };
}

export function withClaudeRuntimeTraitsConfig(
  config: Record<string, unknown>,
  traits: ReturnType<typeof resolveClaudeRuntimeTraits>,
): Record<string, unknown> {
  const {
    effort: _discardedEffort,
    fastMode: _discardedFastMode,
    ultracode: _discardedUltracode,
    alwaysThinkingEnabled: _discardedThinking,
    ...rest
  } = config;
  return {
    ...rest,
    ...(traits.effectiveEffort ? { effort: traits.effectiveEffort } : {}),
    ...claudeRuntimeSettings(traits),
  };
}

export async function lookupClaudeReportedModelContextWindowTokens(
  context: ClaudeSessionContext,
): Promise<number | undefined> {
  const model = getClaudeSessionModel(context);
  if (!model) {
    return undefined;
  }

  if (context.query.initializationResult) {
    const initializationCatalog = readClaudeModelContextWindowCatalog(
      await context.query.initializationResult(),
    );
    const initializationTokens = lookupModelContextWindowTokens({
      provider: "claudeAgent",
      model,
      catalog: initializationCatalog,
    });
    if (initializationTokens !== undefined) {
      return initializationTokens;
    }
  }

  if (context.query.supportedModels) {
    const supportedModelsCatalog = readClaudeModelContextWindowCatalog(
      await context.query.supportedModels(),
    );
    const supportedModelsTokens = lookupModelContextWindowTokens({
      provider: "claudeAgent",
      model,
      catalog: supportedModelsCatalog,
    });
    if (supportedModelsTokens !== undefined) {
      return supportedModelsTokens;
    }
  }

  const fetchedCatalog = await fetchAnthropicModelContextWindowCatalog({
    apiKey: context.processEnvironment.ANTHROPIC_API_KEY,
    authToken: context.processEnvironment.ANTHROPIC_AUTH_TOKEN,
    baseUrl: context.processEnvironment.ANTHROPIC_BASE_URL,
  });
  return lookupModelContextWindowTokens({
    provider: "claudeAgent",
    model,
    catalog: fetchedCatalog,
  });
}

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
// Inline append text is for chat sessions; one-off prompts never received it.
export const CLAUDE_ONE_OFF_EXCLUDED_FLAGS = new Set(["append-system-prompt"]);
export const CLAUDE_ONE_OFF_SELECTION_FLAGS = new Set([
  ...CLAUDE_ONE_OFF_EXCLUDED_FLAGS,
  "model",
  "effort",
  "fallback-model",
]);
export const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

export function buildClaudeQueryEnv(
  providerOptions:
    | {
        readonly subagentModel?: string | undefined;
        readonly subagentEffort?: string | undefined;
      }
    | undefined,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // In SDK mode ENABLE_TODO_TOOLS is the master switch for task tracking and
  // ENABLE_TASKS picks the surface (verified on Claude Code 2.1.292): with
  // TODO_TOOLS unset neither TodoWrite nor TaskCreate is exposed. F5 projects
  // both surfaces and defaults to the native Task tools. Explicit operator
  // values always win.
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !key.toUpperCase().startsWith("F5_PREVIEW_MCP_TOKEN"),
    ),
  );
  const subagentEffort = normalizeOptionalString(providerOptions?.subagentEffort);
  const taskEnvironment = {
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    CLAUDE_CODE_ENABLE_TODO_TOOLS: environment.CLAUDE_CODE_ENABLE_TODO_TOOLS ?? "1",
    CLAUDE_CODE_ENABLE_TASKS: environment.CLAUDE_CODE_ENABLE_TASKS ?? "1",
    // Without it, a sub-agent on another model runs at that model's default effort.
    ...(subagentEffort
      ? { CLAUDE_CODE_SUBAGENT_EFFORT: environment.CLAUDE_CODE_SUBAGENT_EFFORT ?? subagentEffort }
      : {}),
  };
  const rawSubagentModel = normalizeOptionalString(providerOptions?.subagentModel);
  if (!rawSubagentModel) {
    return buildProviderChildProcessEnv(childEnvironment, taskEnvironment);
  }

  if (rawSubagentModel === "inherit") {
    return buildProviderChildProcessEnv(childEnvironment, {
      ...taskEnvironment,
      CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    });
  }

  return buildProviderChildProcessEnv(childEnvironment, {
    ...taskEnvironment,
    CLAUDE_CODE_SUBAGENT_MODEL:
      normalizeModelSlug(rawSubagentModel, "claudeAgent") ?? rawSubagentModel,
  });
}

// Per-turn restatement of the system prompt's File Editing section. Without it
// Claude Code's bypass-mode guidance wins and edits land as opaque shell
// commands instead of reviewable diffs.
export const CLAUDE_FILE_EDITING_REMINDER =
  "File edits: when you change workspace files, use Edit or Write rather than shell writes (sed -i, heredocs, inline scripts) so F5 can show reviewable diffs. Exceptions: codemods across many files, generated output, formatters or code generators, and /tmp scratch files.";

export function buildClaudeTurnRuntimeContext(
  model: string | undefined,
  options: { readonly includeFileEditingReminder: boolean },
): string | undefined {
  const normalizedModel = normalizeOptionalString(model);
  if (!normalizedModel) {
    return undefined;
  }

  return [
    "<f5-runtime-context>",
    `Active model: ${JSON.stringify(normalizeModelSlug(normalizedModel, "claudeAgent") ?? normalizedModel)}`,
    "This host-reported value is authoritative for model identity.",
    ...(options.includeFileEditingReminder ? [CLAUDE_FILE_EDITING_REMINDER] : []),
    "</f5-runtime-context>",
  ].join("\n");
}

export function applyClaudeModelPromptEffort(
  prompt: string,
  model: string | undefined,
  effort: string | undefined,
  reported?: ModelCapabilities,
) {
  const capabilities = resolveModelCapabilities("claudeAgent", model, reported);
  const promptEffort = resolveSupportedEffort(capabilities, effort) as ClaudeCodeEffort | null;
  return applyClaudePromptEffortPrefix(prompt, promptEffort);
}

export function buildPromptText(
  input: ProviderAdapterSendTurnInput,
  options: {
    readonly activeModel?: string;
    /** Session model the effort resolves against when the turn names none. */
    readonly sessionModel?: string;
    readonly allowsWorkspaceEdits: boolean;
    readonly reportedCapabilities?: ModelCapabilities;
  },
): string {
  const userPrompt = applyClaudeModelPromptEffort(
    input.input?.trim() ?? "",
    input.model ?? options.sessionModel,
    input.modelOptions?.claudeAgent?.effort,
    options.reportedCapabilities,
  );
  // Claude Code slash commands must remain the leading prompt text so the CLI
  // can recognize them before normal model dispatch.
  const slashCommand = userPrompt.startsWith("/");
  const runtimeContext = slashCommand
    ? undefined
    : buildClaudeTurnRuntimeContext(options.activeModel, {
        includeFileEditingReminder: options.allowsWorkspaceEdits,
      });
  // MCP App model context follows the user's text, as for Codex; a slash command would
  // read it as arguments, so it waits for the next ordinary turn.
  const prompt =
    input.mcpAppContext && !slashCommand ? `${userPrompt}${input.mcpAppContext}` : userPrompt;
  return (
    appendProviderAttachmentRuntimeContext(
      runtimeContext ? `${runtimeContext}\n\n${prompt}` : prompt,
      input.resolvedAttachments ?? [],
    ) ?? ""
  );
}

export function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
  readonly submissionSource?: ProviderAdapterSendTurnInput["submissionSource"];
}): SDKUserMessage {
  return {
    type: "user",
    uuid: randomUUID(),
    session_id: "",
    parent_tool_use_id: null,
    ...(input.submissionSource === "human" ? { origin: { kind: "human" } } : {}),
    message: {
      role: "user",
      content: input.sdkContent,
    },
  } as unknown as SDKUserMessage;
}

export function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

export function buildUserMessageEffect(
  input: ProviderAdapterSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly documentBudgetKey?: string;
    readonly stateDir?: string;
    readonly activeModel?: string;
    readonly sessionModel?: string | undefined;
    readonly allowsWorkspaceEdits: boolean;
    readonly hostContractUpdate?: string | undefined;
    readonly reportedCapabilities?: ModelCapabilities | undefined;
  },
): Effect.Effect<SDKUserMessage, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const promptText = buildPromptText(input, {
      ...(dependencies.activeModel ? { activeModel: dependencies.activeModel } : {}),
      ...(dependencies.sessionModel ? { sessionModel: dependencies.sessionModel } : {}),
      allowsWorkspaceEdits: dependencies.allowsWorkspaceEdits,
      ...(dependencies.reportedCapabilities
        ? { reportedCapabilities: dependencies.reportedCapabilities }
        : {}),
    });
    const text = dependencies.hostContractUpdate
      ? `# F5 host contract (session update)
This block supersedes earlier transcript copies of the F5 host contract. Its mode, workflow and project context apply only to this session launch; on subsequent launches the current F5 system instructions replace it.
<host-contract>
${dependencies.hostContractUpdate}
</host-contract>

${promptText}`
      : promptText;
    const sdkContent: Array<Record<string, unknown>> = [];

    for (const attachment of input.attachments ?? []) {
      switch (attachment.type) {
        case "image": {
          if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
            });
          }

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: dependencies.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }

          const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/start",
                  detail: toMessage(cause, "Failed to read attachment file."),
                  cause,
                }),
            ),
          );

          sdkContent.push(
            buildClaudeImageContentBlock({
              mimeType: attachment.mimeType,
              bytes,
            }),
          );
          break;
        }
        case "file":
          break;
        default:
          throw new Error(
            `Unsupported Claude attachment type '${String((attachment as { type?: unknown }).type)}'.`,
          );
      }
    }

    if (text.length > 0) {
      sdkContent.push({ type: "text", text });
    }
    if (dependencies.stateDir && dependencies.documentBudgetKey) {
      const documents = yield* Effect.tryPromise({
        try: () =>
          pdfDocuments({
            stateDir: dependencies.stateDir!,
            sessionKey: dependencies.documentBudgetKey!,
            baseBytes: Buffer.byteLength(JSON.stringify(sdkContent)),
            attachments: input.resolvedAttachments ?? [],
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "Could not persist the document request budget.",
            cause,
          }),
      });
      sdkContent.unshift(
        ...documents.map(({ data }) => ({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
        })),
      );
    }
    return buildUserMessage({ sdkContent, submissionSource: input.submissionSource });
  });
}
