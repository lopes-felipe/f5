import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_NEW_THREAD_TITLE,
  type DesktopBridge,
  ProjectId,
  type ProjectSkill,
  type ProjectScript,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadTurnStartBootstrap,
  type CompactRuntimeConfiguredActivityPayload,
  type ProviderKind,
} from "@t3tools/contracts";
import {
  isReservedHostLocalSlashCommandName,
  normalizeHostCompatibleRuntimeSlashCommandName,
} from "@t3tools/shared/slashCommands";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/worktree";
import { type ChatMessage } from "../types";
import { getAppModelOptions } from "../appSettings";
import { type ComposerImageAttachment } from "../composerDraftStore";
import { Schema } from "effect";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import { normalizeAttachedFilePaths, resolveAttachedFileReferencePath } from "../lib/attachedFiles";
import { setupProjectScript } from "~/projectScripts";
import { type ComposerCommandItem } from "./chat/ComposerCommandMenu";
import type { ModelPickerModelOption } from "./chat/providerIconUtils";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export const DISMISSED_PROVIDER_STATUS_KEY = "t3code:dismissed-provider-status-key";

export const DismissedProviderStatusSchema = Schema.NullOr(Schema.String);

const HOST_LOCAL_SLASH_COMMAND_ITEMS = [
  {
    id: "slash:model",
    type: "slash-command",
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
  },
  {
    id: "slash:plan",
    type: "slash-command",
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
  },
  {
    id: "slash:default",
    type: "slash-command",
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal chat mode",
  },
] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;

function normalizeComposerInsertedSkillName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function buildSlashComposerMenuItems(input: {
  query: string;
  runtimeSlashCommands?:
    | CompactRuntimeConfiguredActivityPayload["slashCommands"]
    | null
    | undefined;
  provider?: ProviderKind | null | undefined;
  projectSkills?: ReadonlyArray<ProjectSkill> | null | undefined;
}): Array<Extract<ComposerCommandItem, { type: "slash-command" | "skill" }>> {
  const seenSkillNames = new Set<string>();
  const runtimeSkillItems: Array<Extract<ComposerCommandItem, { type: "skill" }>> = (
    input.runtimeSlashCommands ?? []
  ).flatMap((command) => {
    const name = normalizeHostCompatibleRuntimeSlashCommandName(command.name);
    if (!name || seenSkillNames.has(name)) {
      return [];
    }
    seenSkillNames.add(name);
    return [
      {
        id: `skill:runtime:${name}`,
        type: "skill" as const,
        name,
        label: `/${name}`,
        description: command.description,
        argumentHint: command.argumentHint ?? null,
      },
    ];
  });

  const projectSkillItems: Array<Extract<ComposerCommandItem, { type: "skill" }>> = (
    input.provider === "claudeAgent" ? (input.projectSkills ?? []) : []
  )
    .filter((skill) => skill.paths.length === 0)
    .flatMap((skill) => {
      const name = normalizeComposerInsertedSkillName(skill.commandName);
      if (
        name.length === 0 ||
        isReservedHostLocalSlashCommandName(name) ||
        seenSkillNames.has(name)
      ) {
        return [];
      }
      // Runtime commands are authoritative when both sources publish the same
      // menu name, so project skills only fill names runtime did not claim.
      seenSkillNames.add(name);
      return [
        {
          id: `skill:project:${name}`,
          type: "skill" as const,
          name,
          label: `/${name}`,
          description: skill.description,
          argumentHint: skill.argumentHint,
        },
      ];
    });

  const query = input.query.trim().toLowerCase();
  const slashItems = [
    ...HOST_LOCAL_SLASH_COMMAND_ITEMS,
    ...runtimeSkillItems,
    ...projectSkillItems,
  ] satisfies Array<Extract<ComposerCommandItem, { type: "slash-command" | "skill" }>>;
  if (!query) {
    return slashItems;
  }
  return slashItems.filter((item) => {
    if (item.type === "slash-command") {
      return (
        item.command.includes(query) ||
        item.label.slice(1).includes(query) ||
        item.description.toLowerCase().includes(query)
      );
    }
    return (
      item.name.includes(query) ||
      item.label.slice(1).includes(query) ||
      item.description.toLowerCase().includes(query)
    );
  });
}

export function buildComposerSkillReplacement(skillName: string): string {
  return `/${normalizeComposerInsertedSkillName(skillName)} `;
}

export function rewriteComposerRuntimeSkillInvocationForSend(input: {
  text: string;
  provider: ProviderKind | null | undefined;
  runtimeSlashCommands?:
    | CompactRuntimeConfiguredActivityPayload["slashCommands"]
    | null
    | undefined;
}): string {
  if (input.provider !== "codex") {
    return input.text;
  }

  const leadingCommandMatch = /^\/([^\s/]+)(?=\s|$)/.exec(input.text);
  if (!leadingCommandMatch) {
    return input.text;
  }

  const leadingCommandName = normalizeHostCompatibleRuntimeSlashCommandName(
    leadingCommandMatch[1] ?? "",
  );
  if (!leadingCommandName) {
    return input.text;
  }

  const knownRuntimeSkillNames = new Set(
    (input.runtimeSlashCommands ?? [])
      .map((command) => normalizeHostCompatibleRuntimeSlashCommandName(command.name))
      .flatMap((name) => (name ? [name] : [])),
  );
  if (!knownRuntimeSkillNames.has(leadingCommandName)) {
    return input.text;
  }

  return `$${leadingCommandName}${input.text.slice(leadingCommandMatch[0].length)}`;
}

export function shouldRenderTimelineContent(input: {
  detailsLoaded: boolean;
  hasRenderableMessage: boolean;
}): boolean {
  return input.detailsLoaded || input.hasRenderableMessage;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function revokeComposerImagePreviewUrls(
  images: ReadonlyArray<ComposerImageAttachment>,
): void {
  for (const image of images) {
    revokeBlobPreviewUrl(image.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export type PendingTurnDispatchStatus =
  | "dispatching"
  | "awaiting-recovery"
  | "awaiting-user-action";

export interface PendingTurnDispatchRollback {
  prompt: string;
  images: ComposerImageAttachment[];
  filePaths: string[];
  terminalContexts: TerminalContextDraft[];
  interactionMode: ProviderInteractionMode;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export interface ProviderRuntimeInfoEntry {
  readonly label: string;
  readonly value: string;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function readAttachedFileAbsolutePath(
  file: File,
  options: {
    isElectron: boolean;
    desktopBridge?: Pick<DesktopBridge, "getPathForFile"> | undefined;
  },
): string | undefined {
  const bridgedPath = options.desktopBridge?.getPathForFile?.(file);
  if (typeof bridgedPath === "string" && bridgedPath.length > 0) {
    return bridgedPath;
  }
  if (!options.isElectron) {
    return undefined;
  }
  const legacyPath = (file as File & { path?: string }).path;
  return typeof legacyPath === "string" && legacyPath.length > 0 ? legacyPath : undefined;
}

export const identityAbsolutePathNormalizer = (pathValue: string) => pathValue;

export function createCachedAbsolutePathComparisonNormalizer(
  normalizeAbsolutePathForComparison:
    | ((pathValue: string) => string | null | undefined)
    | undefined,
): (pathValue: string) => string | null | undefined {
  const cache = new Map<string, string | null | undefined>();
  return (pathValue: string) => {
    const cached = cache.get(pathValue);
    if (cached !== undefined || cache.has(pathValue)) {
      return cached;
    }
    const normalized = normalizeAbsolutePathForComparison?.(pathValue) ?? pathValue;
    cache.set(pathValue, normalized);
    return normalized;
  };
}

export function resolveAttachedFileReferencePaths(input: {
  files: ReadonlyArray<File>;
  isElectron: boolean;
  desktopBridge?: Pick<DesktopBridge, "getPathForFile"> | undefined;
  workspaceRoots: ReadonlyArray<string | null | undefined>;
  normalizeAbsolutePathForComparison?:
    | ((pathValue: string) => string | null | undefined)
    | undefined;
}): {
  filePaths: string[];
  missingPathCount: number;
  invalidPathCount: number;
} {
  let missingPathCount = 0;
  let invalidPathCount = 0;
  const filePaths: string[] = [];

  for (const file of input.files) {
    const absolutePath = readAttachedFileAbsolutePath(file, {
      isElectron: input.isElectron,
      desktopBridge: input.desktopBridge,
    });
    if (!absolutePath) {
      missingPathCount += 1;
      continue;
    }
    const referencePath = resolveAttachedFileReferencePath(absolutePath, input.workspaceRoots, {
      normalizeAbsolutePathForComparison: input.normalizeAbsolutePathForComparison,
    });
    if (!referencePath) {
      invalidPathCount += 1;
      continue;
    }
    filePaths.push(referencePath);
  }

  return {
    filePaths: normalizeAttachedFilePaths(filePaths),
    missingPathCount,
    invalidPathCount,
  };
}

export function buildFirstSendBootstrap(input: {
  isLocalDraftThread: boolean;
  projectId: ProjectId;
  projectCwd: string;
  projectModel: string | null | undefined;
  projectScripts: ProjectScript[];
  selectedModel: string | null | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  thread: {
    branch: string | null;
    worktreePath: string | null;
    createdAt: string;
  };
  baseBranchForWorktree: string | null;
}): ThreadTurnStartBootstrap | undefined {
  const createThread = input.isLocalDraftThread
    ? {
        projectId: input.projectId,
        title: DEFAULT_NEW_THREAD_TITLE,
        model: input.selectedModel ?? input.projectModel ?? DEFAULT_MODEL_BY_PROVIDER.codex,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        branch: input.thread.branch,
        worktreePath: input.thread.worktreePath,
        createdAt: input.thread.createdAt,
      }
    : undefined;
  const prepareWorktree = input.baseBranchForWorktree
    ? {
        projectCwd: input.projectCwd,
        baseBranch: input.baseBranchForWorktree,
        branch: buildTemporaryWorktreeBranchName(),
      }
    : undefined;

  if (!createThread && !prepareWorktree) {
    return undefined;
  }

  const shouldRunSetupScript = prepareWorktree && setupProjectScript(input.projectScripts);

  return {
    ...(createThread ? { createThread } : {}),
    ...(prepareWorktree ? { prepareWorktree } : {}),
    ...(shouldRunSetupScript ? { runSetupScript: true } : {}),
  };
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function getCustomModelOptionsByProvider(settings: {
  customCodexModels: readonly string[];
  customClaudeModels: readonly string[];
}): Record<ProviderKind, ReadonlyArray<ModelPickerModelOption>> {
  return {
    codex: getAppModelOptions("codex", settings.customCodexModels),
    claudeAgent: getAppModelOptions("claudeAgent", settings.customClaudeModels),
  };
}

function readRerouteString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function deriveProviderRuntimeInfoEntries(input: {
  provider: ProviderKind | null;
  threadModel: string | null;
  configuredRuntime: CompactRuntimeConfiguredActivityPayload | null;
  rerouteActivity: Record<string, unknown> | null;
  cliVersion: string | null;
  mcpSummary: string | null;
}): ProviderRuntimeInfoEntry[] {
  if (!input.provider) {
    return [];
  }

  if (input.provider === "claudeAgent") {
    return [
      input.configuredRuntime?.model
        ? { label: "Actual model", value: input.configuredRuntime.model }
        : null,
      input.configuredRuntime?.claudeCodeVersion
        ? { label: "Claude Code", value: input.configuredRuntime.claudeCodeVersion }
        : null,
      input.configuredRuntime?.fastModeState
        ? { label: "Fast mode", value: input.configuredRuntime.fastModeState }
        : null,
      input.configuredRuntime?.effort
        ? { label: "Effort", value: input.configuredRuntime.effort }
        : null,
      input.configuredRuntime?.outputStyle
        ? { label: "Output", value: input.configuredRuntime.outputStyle }
        : null,
      input.configuredRuntime?.instructionContractVersion
        ? { label: "Contract", value: input.configuredRuntime.instructionContractVersion }
        : null,
      input.configuredRuntime?.instructionStrategy
        ? { label: "Instructions", value: input.configuredRuntime.instructionStrategy }
        : null,
      input.configuredRuntime?.sessionId
        ? { label: "Session", value: input.configuredRuntime.sessionId }
        : null,
      input.mcpSummary ? { label: "MCP", value: input.mcpSummary } : null,
      input.cliVersion ? { label: "CLI", value: input.cliVersion } : null,
    ].filter((entry): entry is ProviderRuntimeInfoEntry => entry !== null);
  }

  if (input.provider === "codex") {
    return [
      input.threadModel ? { label: "Actual model", value: input.threadModel } : null,
      input.configuredRuntime?.instructionContractVersion
        ? { label: "Contract", value: input.configuredRuntime.instructionContractVersion }
        : null,
      input.configuredRuntime?.instructionStrategy
        ? { label: "Instructions", value: input.configuredRuntime.instructionStrategy }
        : null,
      readRerouteString(input.rerouteActivity, "fromModel")
        ? { label: "Rerouted from", value: readRerouteString(input.rerouteActivity, "fromModel")! }
        : null,
      readRerouteString(input.rerouteActivity, "reason")
        ? { label: "Reason", value: readRerouteString(input.rerouteActivity, "reason")! }
        : null,
      input.mcpSummary ? { label: "MCP", value: input.mcpSummary } : null,
      input.cliVersion ? { label: "CLI", value: input.cliVersion } : null,
    ].filter((entry): entry is ProviderRuntimeInfoEntry => entry !== null);
  }

  return [];
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  filePathCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      options.filePathCount > 0 ||
      sendableTerminalContexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}
