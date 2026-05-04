import {
  type CompactMcpOauthActivityPayload,
  type CompactMcpStatusActivityPayload,
  isToolLifecycleItemType,
  type CompactRuntimeConfiguredActivityPayload,
  type CompactToolActivityPayload,
  OrchestrationFileChangeId,
  ProviderItemId,
  type ProviderRequestKind,
  type RuntimeItemStatus,
} from "@t3tools/contracts";
import {
  deriveSearchSummaryFromPatternsAndTargets,
  formatLineRangeSummary,
} from "./commandSummary";

type UnknownRecord = Record<string, unknown>;

const MAX_CHANGED_FILE_PREVIEW = 12;
const MAX_COMPACT_TEXT_CHARS = 4_000;
const APPLY_PATCH_FILE_HEADER_REGEX = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
const APPLY_PATCH_MOVE_TO_REGEX = /^\*\*\* Move to: (.+)$/gm;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRequestKind(value: unknown): ProviderRequestKind | undefined {
  if (
    value === "command" ||
    value === "file-read" ||
    value === "file-change" ||
    value === "permission"
  ) {
    return value;
  }
  return undefined;
}

function normalizeRuntimeItemStatus(value: unknown): RuntimeItemStatus | undefined {
  switch (value) {
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "completed":
    case "failed":
    case "declined":
      return value;
    default:
      return undefined;
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectApplyPatchChangedFiles(patchText: string, target: string[], seen: Set<string>) {
  for (const regex of [APPLY_PATCH_FILE_HEADER_REGEX, APPLY_PATCH_MOVE_TO_REGEX]) {
    regex.lastIndex = 0;
    let match = regex.exec(patchText);
    while (match) {
      pushChangedFile(target, seen, match[1]);
      if (target.length >= MAX_CHANGED_FILE_PREVIEW) {
        return;
      }
      match = regex.exec(patchText);
    }
  }
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= MAX_CHANGED_FILE_PREVIEW) {
    return;
  }
  if (typeof value === "string") {
    collectApplyPatchChangedFiles(value, target, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= MAX_CHANGED_FILE_PREVIEW) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.file_path);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.relative_path);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.notebook_path);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.new_path);
  pushChangedFile(target, seen, record.oldPath);
  pushChangedFile(target, seen, record.old_path);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= MAX_CHANGED_FILE_PREVIEW) {
      return;
    }
  }
}

function extractChangedFilesFromPayload(payload: UnknownRecord): string[] | undefined {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload.data), changedFiles, seen, 0);
  return changedFiles.length > 0 ? changedFiles : undefined;
}

function normalizeChangedFiles(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    pushChangedFile(changedFiles, seen, entry);
    if (changedFiles.length >= MAX_CHANGED_FILE_PREVIEW) {
      break;
    }
  }
  return changedFiles.length > 0 ? changedFiles : undefined;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    pushChangedFile(normalized, seen, entry);
  }
  return normalized.length > 0 ? normalized : undefined;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const parsed = asInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function extractCommandFromPayload(payload: UnknownRecord): string | undefined {
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  return (
    normalizeCommandValue(payload.command) ??
    normalizeCommandValue(item?.command) ??
    normalizeCommandValue(itemInput?.command) ??
    normalizeCommandValue(itemResult?.command) ??
    normalizeCommandValue(data?.command)
  );
}

function extractCompactText(value: unknown): string | undefined {
  const trimmed = extractTextContent(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function truncateCompactText(value: string | undefined, maxChars = MAX_COMPACT_TEXT_CHARS) {
  if (!value) {
    return undefined;
  }
  if (value.length <= maxChars) {
    return value;
  }
  const truncated = value.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${truncated}…`;
}

function safeJsonStringify(value: unknown): string | undefined {
  const seen = new WeakSet<object>();

  try {
    return asTrimmedString(
      JSON.stringify(
        value,
        (_key, currentValue) => {
          if (typeof currentValue === "bigint") {
            return `${currentValue}n`;
          }
          if (currentValue !== null && typeof currentValue === "object") {
            if (seen.has(currentValue)) {
              return "[Circular]";
            }
            seen.add(currentValue);
          }
          return currentValue;
        },
        2,
      ),
    );
  } catch {
    return undefined;
  }
}

function readSubagentPayload(payload: UnknownRecord): Partial<CompactToolActivityPayload> {
  if (payload.itemType !== "collab_agent_tool_call") {
    return {};
  }

  const data = asRecord(payload.data);
  const input = asRecord(data?.input);
  const result = asRecord(data?.result);

  const subagentType =
    asTrimmedString(payload.subagentType) ??
    asTrimmedString(data?.subagentType) ??
    asTrimmedString(input?.subagent_type);
  const subagentDescription =
    asTrimmedString(payload.subagentDescription) ??
    asTrimmedString(data?.subagentDescription) ??
    asTrimmedString(input?.description);
  const subagentPrompt = truncateCompactText(
    asTrimmedString(payload.subagentPrompt) ??
      asTrimmedString(data?.subagentPrompt) ??
      asTrimmedString(input?.prompt),
  );
  const subagentResult = truncateCompactText(
    asTrimmedString(payload.subagentResult) ??
      asTrimmedString(data?.subagentResult) ??
      extractCompactText(result?.content) ??
      extractCompactText(result),
  );
  const subagentModel =
    asTrimmedString(payload.subagentModel) ??
    asTrimmedString(data?.subagentModel) ??
    asTrimmedString(input?.model);

  return {
    ...(subagentType ? { subagentType } : {}),
    ...(subagentDescription ? { subagentDescription } : {}),
    ...(subagentPrompt ? { subagentPrompt } : {}),
    ...(subagentResult ? { subagentResult } : {}),
    ...(subagentModel ? { subagentModel } : {}),
  };
}

function serializeMcpValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record && Object.keys(record).length === 0) {
    return undefined;
  }
  return safeJsonStringify(value);
}

function buildMcpToolName(
  serverName: string | undefined,
  toolName: string | undefined,
): string | undefined {
  if (!serverName || !toolName) {
    return undefined;
  }
  return `mcp__${serverName}__${toolName}`;
}

function serializeMcpResult(value: unknown): string | undefined {
  const record = asRecord(value);
  return extractCompactText(record?.content ?? value) ?? serializeMcpValue(value);
}

function extractToolNameFromDetail(detail: string): string | undefined {
  const separatorIndex = detail.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }
  return asTrimmedString(detail.slice(0, separatorIndex));
}

function extractInputPreviewFromDetail(detail: string): string | undefined {
  const separatorIndex = detail.indexOf(":");
  if (separatorIndex < 0) {
    return undefined;
  }
  const preview = asTrimmedString(detail.slice(separatorIndex + 1));
  if (!preview || preview === "{}") {
    return undefined;
  }
  return preview;
}

function isGenericToolTitle(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  return /^(?:tool(?: call)?|item)$/i.test(value.trim());
}

function readToolName(payload: UnknownRecord): string | undefined {
  const data = asRecord(payload.data);
  return (
    asTrimmedString(data?.toolName) ??
    (() => {
      const detail = asTrimmedString(payload.detail);
      return detail ? extractToolNameFromDetail(detail) : undefined;
    })()
  );
}

function readToolInput(payload: UnknownRecord): UnknownRecord | null {
  const data = asRecord(payload.data);
  return asRecord(data?.input);
}

function readToolReadPaths(
  toolName: string | undefined,
  input: UnknownRecord | null,
): string[] | undefined {
  if (!toolName || !input) {
    return undefined;
  }

  const normalizedToolName = toolName.trim().toLowerCase();
  const command = asTrimmedString(input.command)?.toLowerCase();
  const isReadTool =
    normalizedToolName === "read" ||
    normalizedToolName === "view" ||
    normalizedToolName === "notebookread" ||
    (normalizedToolName === "str_replace_based_edit_tool" &&
      (command === "view" || command === "view_range"));
  if (!isReadTool) {
    return undefined;
  }

  const rawPath =
    asTrimmedString(input.file_path) ??
    asTrimmedString(input.notebook_path) ??
    asTrimmedString(input.path);
  return rawPath ? [rawPath] : undefined;
}

function readToolLineSummary(
  toolName: string | undefined,
  input: UnknownRecord | null,
): string | undefined {
  if (!toolName || !input) {
    return undefined;
  }

  const normalizedToolName = toolName.trim().toLowerCase();
  const command = asTrimmedString(input.command)?.toLowerCase();
  const isReadTool =
    normalizedToolName === "read" ||
    normalizedToolName === "view" ||
    normalizedToolName === "notebookread" ||
    (normalizedToolName === "str_replace_based_edit_tool" &&
      (command === "view" || command === "view_range"));
  if (!isReadTool) {
    return undefined;
  }

  const rawViewRange = Array.isArray(input.view_range)
    ? input.view_range
    : Array.isArray(input.viewRange)
      ? input.viewRange
      : undefined;
  if (rawViewRange && rawViewRange.length >= 2) {
    const startLine = asPositiveInteger(rawViewRange[0]);
    const endLine = asInteger(rawViewRange[1]);
    if (startLine !== undefined && endLine !== undefined) {
      return formatLineRangeSummary({ startLine, endLine }) ?? undefined;
    }
  }

  const startLine =
    asPositiveInteger(input.line) ??
    asPositiveInteger(input.line_number) ??
    asPositiveInteger(input.lineNumber) ??
    asPositiveInteger(input.start_line) ??
    asPositiveInteger(input.startLine);
  if (startLine !== undefined) {
    const endLine =
      asInteger(input.end_line) ??
      asInteger(input.endLine) ??
      asInteger(input.stop_line) ??
      asInteger(input.stopLine);
    return (
      formatLineRangeSummary({
        startLine,
        ...(endLine !== undefined ? { endLine } : {}),
      }) ?? undefined
    );
  }

  const offset = asPositiveInteger(input.offset);
  const limit = asPositiveInteger(input.limit) ?? asPositiveInteger(input.max_lines);
  if (offset !== undefined && limit !== undefined) {
    return (
      formatLineRangeSummary({
        startLine: offset,
        endLine: limit > 1 ? offset + limit - 1 : offset,
      }) ?? undefined
    );
  }

  return undefined;
}

function readToolSearchSummary(
  toolName: string | undefined,
  input: UnknownRecord | null,
): string | undefined {
  if (!toolName || !input) {
    return undefined;
  }

  const normalizedToolName = toolName.trim().toLowerCase();
  if (normalizedToolName !== "grep" && normalizedToolName !== "glob") {
    return undefined;
  }

  const pattern =
    asTrimmedString(input.pattern) ?? asTrimmedString(input.query) ?? asTrimmedString(input.glob);
  if (!pattern) {
    return undefined;
  }

  const targets = [
    asTrimmedString(input.path),
    asTrimmedString(input.directory),
    asTrimmedString(input.cwd),
  ].filter((value): value is string => value !== undefined);

  return (
    deriveSearchSummaryFromPatternsAndTargets({
      patterns: [pattern],
      targets,
    }) ?? undefined
  );
}

function readNormalizedDynamicToolPayload(
  payload: UnknownRecord,
): Partial<CompactToolActivityPayload> {
  if (payload.itemType !== "dynamic_tool_call") {
    return {};
  }

  const toolName = readToolName(payload);
  const input = readToolInput(payload);
  const title = asTrimmedString(payload.title);
  const readPaths = readToolReadPaths(toolName, input);
  const lineSummary = readToolLineSummary(toolName, input);
  const searchSummary = readToolSearchSummary(toolName, input);
  const normalizedToolName = toolName?.trim().toLowerCase();

  const normalizedTitle =
    isGenericToolTitle(title) || !title
      ? (searchSummary ??
        (readPaths && readPaths.length > 0
          ? "Read file"
          : normalizedToolName === "ls"
            ? "List directory"
            : title))
      : title;

  return {
    ...(normalizedTitle ? { title: normalizedTitle } : {}),
    ...(readPaths && readPaths.length > 0 ? { readPaths } : {}),
    ...(lineSummary ? { lineSummary } : {}),
    ...(searchSummary ? { searchSummary } : {}),
  };
}

export function parseMcpToolName(rawName: string): { server: string; tool: string } | null {
  const trimmed = rawName.trim();
  if (!trimmed.startsWith("mcp__")) {
    return null;
  }

  const remainder = trimmed.slice("mcp__".length);
  const separatorIndex = remainder.indexOf("__");
  if (separatorIndex <= 0 || separatorIndex >= remainder.length - 2) {
    return null;
  }

  const server = remainder.slice(0, separatorIndex).trim();
  const tool = remainder.slice(separatorIndex + 2).trim();
  if (server.length === 0 || tool.length === 0) {
    return null;
  }

  return { server, tool };
}

function readMcpToolPayload(payload: UnknownRecord): Partial<CompactToolActivityPayload> {
  if (payload.itemType !== "mcp_tool_call") {
    return {};
  }

  const data = asRecord(payload.data);
  const dataItem = asRecord(data?.item);
  const detail = asTrimmedString(payload.detail);
  const compactServerName = asTrimmedString(payload.mcpServerName);
  const compactToolName = asTrimmedString(payload.mcpToolName);
  const codexServerName = asTrimmedString(dataItem?.server) ?? asTrimmedString(data?.server);
  const codexToolName = asTrimmedString(dataItem?.tool) ?? asTrimmedString(data?.tool);
  const rawToolName =
    asTrimmedString(dataItem?.toolName) ??
    asTrimmedString(data?.toolName) ??
    buildMcpToolName(codexServerName, codexToolName) ??
    compactToolName ??
    (detail ? extractToolNameFromDetail(detail) : undefined);
  const parsedToolName = rawToolName ? parseMcpToolName(rawToolName) : null;

  const mcpServerName = compactServerName ?? codexServerName ?? parsedToolName?.server;
  const mcpToolName = compactToolName ?? codexToolName ?? parsedToolName?.tool ?? rawToolName;
  const mcpInput = truncateCompactText(
    asTrimmedString(payload.mcpInput) ??
      serializeMcpValue(dataItem?.input) ??
      serializeMcpValue(data?.input) ??
      serializeMcpValue(dataItem?.arguments) ??
      serializeMcpValue(data?.arguments) ??
      (detail ? extractInputPreviewFromDetail(detail) : undefined),
  );
  const mcpResult = truncateCompactText(
    asTrimmedString(payload.mcpResult) ?? serializeMcpResult(dataItem?.result ?? data?.result),
  );

  return {
    ...(mcpServerName ? { mcpServerName } : {}),
    ...(mcpToolName ? { mcpToolName } : {}),
    ...(mcpInput ? { mcpInput } : {}),
    ...(mcpResult ? { mcpResult } : {}),
  };
}

function compactToolPayload(payload: CompactToolActivityPayload): Record<string, unknown> {
  return {
    itemType: payload.itemType,
    ...(payload.providerItemId ? { providerItemId: payload.providerItemId } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.detail ? { detail: payload.detail } : {}),
    ...(payload.requestKind ? { requestKind: payload.requestKind } : {}),
    ...(payload.itemType === "command_execution" && payload.command
      ? { command: payload.command }
      : {}),
    ...(payload.readPaths && payload.readPaths.length > 0
      ? { readPaths: [...payload.readPaths] }
      : {}),
    ...(payload.lineSummary ? { lineSummary: payload.lineSummary } : {}),
    ...(payload.searchSummary ? { searchSummary: payload.searchSummary } : {}),
    ...(payload.itemType === "file_change" &&
    payload.changedFiles &&
    payload.changedFiles.length > 0
      ? { changedFiles: [...payload.changedFiles] }
      : {}),
    ...(payload.itemType === "file_change" && payload.fileChangeId
      ? { fileChangeId: payload.fileChangeId }
      : {}),
    ...(payload.itemType === "collab_agent_tool_call" && payload.subagentType
      ? { subagentType: payload.subagentType }
      : {}),
    ...(payload.itemType === "collab_agent_tool_call" && payload.subagentDescription
      ? { subagentDescription: payload.subagentDescription }
      : {}),
    ...(payload.itemType === "collab_agent_tool_call" && payload.subagentPrompt
      ? { subagentPrompt: payload.subagentPrompt }
      : {}),
    ...(payload.itemType === "collab_agent_tool_call" && payload.subagentResult
      ? { subagentResult: payload.subagentResult }
      : {}),
    ...(payload.itemType === "collab_agent_tool_call" && payload.subagentModel
      ? { subagentModel: payload.subagentModel }
      : {}),
    ...(payload.itemType === "mcp_tool_call" && payload.mcpServerName
      ? { mcpServerName: payload.mcpServerName }
      : {}),
    ...(payload.itemType === "mcp_tool_call" && payload.mcpToolName
      ? { mcpToolName: payload.mcpToolName }
      : {}),
    ...(payload.itemType === "mcp_tool_call" && payload.mcpInput
      ? { mcpInput: payload.mcpInput }
      : {}),
    ...(payload.itemType === "mcp_tool_call" && payload.mcpResult
      ? { mcpResult: payload.mcpResult }
      : {}),
  };
}

function readConfiguredValue(value: unknown, fallback: unknown): string | undefined {
  return asTrimmedString(value) ?? asTrimmedString(fallback);
}

function readInstructionProfile(payload: UnknownRecord | null): UnknownRecord | null {
  return asRecord(payload?.instructionProfile);
}

function compactRuntimeConfiguredPayload(
  payload: CompactRuntimeConfiguredActivityPayload,
): Record<string, unknown> {
  return {
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.claudeCodeVersion ? { claudeCodeVersion: payload.claudeCodeVersion } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.fastModeState ? { fastModeState: payload.fastModeState } : {}),
    ...(payload.effort ? { effort: payload.effort } : {}),
    ...(payload.outputStyle ? { outputStyle: payload.outputStyle } : {}),
    ...(payload.instructionContractVersion
      ? { instructionContractVersion: payload.instructionContractVersion }
      : {}),
    ...(payload.instructionSupplementVersion
      ? { instructionSupplementVersion: payload.instructionSupplementVersion }
      : {}),
    ...(payload.instructionStrategy ? { instructionStrategy: payload.instructionStrategy } : {}),
    ...(payload.slashCommands ? { slashCommands: [...payload.slashCommands] } : {}),
  };
}

export function readToolActivityPayload(payload: unknown): CompactToolActivityPayload | null {
  const record = asRecord(payload);
  if (!record || typeof record.itemType !== "string" || !isToolLifecycleItemType(record.itemType)) {
    return null;
  }

  const providerItemId = (() => {
    const value = asTrimmedString(record.providerItemId);
    return value ? ProviderItemId.makeUnsafe(value) : undefined;
  })();
  const status = normalizeRuntimeItemStatus(record.status);
  const normalizedDynamicToolPayload = readNormalizedDynamicToolPayload(record);
  const title =
    asTrimmedString(normalizedDynamicToolPayload.title) ?? asTrimmedString(record.title);
  const detail = asTrimmedString(record.detail);
  const requestKind = normalizeRequestKind(record.requestKind);
  const command =
    record.itemType === "command_execution" ? extractCommandFromPayload(record) : undefined;
  const readPaths =
    normalizeStringList(record.readPaths) ??
    normalizeStringList(normalizedDynamicToolPayload.readPaths);
  const lineSummary =
    asTrimmedString(record.lineSummary) ??
    asTrimmedString(normalizedDynamicToolPayload.lineSummary);
  const searchSummary =
    asTrimmedString(record.searchSummary) ??
    asTrimmedString(normalizedDynamicToolPayload.searchSummary);
  const changedFiles =
    record.itemType === "file_change"
      ? (normalizeChangedFiles(record.changedFiles) ?? extractChangedFilesFromPayload(record))
      : undefined;
  const fileChangeId =
    record.itemType === "file_change"
      ? (() => {
          const value = asTrimmedString(record.fileChangeId);
          return value ? OrchestrationFileChangeId.makeUnsafe(value) : undefined;
        })()
      : undefined;
  const subagentPayload = readSubagentPayload(record);
  const mcpPayload = readMcpToolPayload(record);

  return {
    itemType: record.itemType,
    ...(providerItemId ? { providerItemId } : {}),
    ...(status ? { status } : {}),
    ...(title ? { title } : {}),
    ...(detail ? { detail } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(command ? { command } : {}),
    ...(readPaths && readPaths.length > 0 ? { readPaths } : {}),
    ...(lineSummary ? { lineSummary } : {}),
    ...(searchSummary ? { searchSummary } : {}),
    ...(changedFiles && changedFiles.length > 0 ? { changedFiles } : {}),
    ...(fileChangeId ? { fileChangeId } : {}),
    ...subagentPayload,
    ...mcpPayload,
  };
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  return extractTextContent(record.content);
}

function readRuntimeSlashCommands(
  value: unknown,
): CompactRuntimeConfiguredActivityPayload["slashCommands"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const slashCommands = value
    .flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) {
        return [];
      }
      const name = asTrimmedString(record.name);
      const description = asTrimmedString(record.description);
      const argumentHint = asTrimmedString(record.argumentHint);
      if (!name || !description) {
        return [];
      }
      return [
        {
          name,
          description,
          ...(argumentHint ? { argumentHint } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));

  return slashCommands;
}

export function readRuntimeConfiguredPayload(
  payload: unknown,
): CompactRuntimeConfiguredActivityPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const config = asRecord(record.config);
  const instructionProfile = readInstructionProfile(record) ?? readInstructionProfile(config);
  const slashCommands = readRuntimeSlashCommands(record.slashCommands ?? config?.slashCommands);
  const result: CompactRuntimeConfiguredActivityPayload = {
    ...(readConfiguredValue(record.model, config?.model)
      ? { model: readConfiguredValue(record.model, config?.model)! }
      : {}),
    ...(readConfiguredValue(record.claudeCodeVersion, config?.claude_code_version)
      ? {
          claudeCodeVersion: readConfiguredValue(
            record.claudeCodeVersion,
            config?.claude_code_version,
          )!,
        }
      : {}),
    ...(readConfiguredValue(record.sessionId, config?.session_id)
      ? {
          sessionId: readConfiguredValue(record.sessionId, config?.session_id)!,
        }
      : {}),
    ...(readConfiguredValue(record.fastModeState, config?.fast_mode_state)
      ? {
          fastModeState: readConfiguredValue(record.fastModeState, config?.fast_mode_state)!,
        }
      : {}),
    ...(readConfiguredValue(record.effort, config?.effort)
      ? { effort: readConfiguredValue(record.effort, config?.effort)! }
      : {}),
    ...(readConfiguredValue(record.outputStyle, config?.output_style)
      ? {
          outputStyle: readConfiguredValue(record.outputStyle, config?.output_style)!,
        }
      : {}),
    ...(readConfiguredValue(record.instructionContractVersion, instructionProfile?.contractVersion)
      ? {
          instructionContractVersion: readConfiguredValue(
            record.instructionContractVersion,
            instructionProfile?.contractVersion,
          )!,
        }
      : {}),
    ...(readConfiguredValue(
      record.instructionSupplementVersion,
      instructionProfile?.providerSupplementVersion,
    )
      ? {
          instructionSupplementVersion: readConfiguredValue(
            record.instructionSupplementVersion,
            instructionProfile?.providerSupplementVersion,
          )!,
        }
      : {}),
    ...(readConfiguredValue(record.instructionStrategy, instructionProfile?.strategy)
      ? {
          instructionStrategy: readConfiguredValue(
            record.instructionStrategy,
            instructionProfile?.strategy,
          )!,
        }
      : {}),
    ...(slashCommands !== undefined ? { slashCommands } : {}),
  };

  return Object.keys(result).length > 0 ? result : null;
}

export function readMcpStatusActivityPayload(
  payload: unknown,
): CompactMcpStatusActivityPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }

  const statusRecord = asRecord(record.status);
  const name = asTrimmedString(record.name) ?? asTrimmedString(statusRecord?.name);
  const statusValue = asTrimmedString(record.status) ?? asTrimmedString(statusRecord?.status);
  const error = asTrimmedString(record.error) ?? asTrimmedString(statusRecord?.error);
  const rawToolCount = record.toolCount ?? statusRecord?.toolCount;
  const toolCount =
    typeof rawToolCount === "number" && Number.isInteger(rawToolCount) && rawToolCount >= 0
      ? rawToolCount
      : undefined;

  if (
    statusValue !== "starting" &&
    statusValue !== "ready" &&
    statusValue !== "failed" &&
    statusValue !== "cancelled"
  ) {
    return null;
  }

  return {
    status: statusValue,
    ...(name ? { name } : {}),
    ...(error ? { error } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
  };
}

export function readMcpOauthActivityPayload(
  payload: unknown,
): CompactMcpOauthActivityPayload | null {
  const record = asRecord(payload);
  if (!record || typeof record.success !== "boolean") {
    return null;
  }

  const name = asTrimmedString(record.name);
  const error = asTrimmedString(record.error);
  return {
    success: record.success,
    ...(name ? { name } : {}),
    ...(error ? { error } : {}),
  };
}

export function compactThreadActivityPayload(input: {
  kind: string;
  payload: unknown;
}): Record<string, unknown> {
  const payload = asRecord(input.payload);
  if (!payload) {
    return {};
  }

  switch (input.kind) {
    case "tool.started":
    case "tool.updated":
    case "tool.completed": {
      const toolPayload = readToolActivityPayload(payload);
      return toolPayload ? compactToolPayload(toolPayload) : payload;
    }
    case "runtime.configured": {
      const runtimePayload = readRuntimeConfiguredPayload(payload);
      return runtimePayload ? compactRuntimeConfiguredPayload(runtimePayload) : payload;
    }
    case "mcp.status.updated": {
      const mcpPayload = readMcpStatusActivityPayload(payload);
      return mcpPayload ? mcpPayload : payload;
    }
    case "mcp.oauth.completed": {
      const mcpPayload = readMcpOauthActivityPayload(payload);
      return mcpPayload ? mcpPayload : payload;
    }
    default:
      return payload;
  }
}
