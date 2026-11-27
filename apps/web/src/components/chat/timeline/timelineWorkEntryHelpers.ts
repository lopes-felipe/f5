import { computerToolHeading, previewToolHeading } from "@t3tools/shared/computerAction";
import { classifyAutomationEntry } from "../AutomationSessionCard.logic";
import { type TurnId } from "@t3tools/contracts";
import type { deriveTimelineEntries } from "../../../session-logic";
import { type TurnDiffSummary } from "../../../types";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  ImageIcon,
  ListTodoIcon,
  type LucideIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  ZapIcon,
} from "lucide-react";
import { type Icon } from "../../Icons";
import {
  describeDynamicToolEntry,
  type DynamicToolIconKind,
  isFileChangeWorkEntry,
  isFileReadWorkEntry,
  isSearchWorkEntry,
  normalizeCompactToolLabel,
  normalizedSearchSummary,
  normalizedWorkEntryHeading,
} from "../MessagesTimeline.logic";
import { relativePathForDisplay } from "~/lib/attachedFiles";
import {
  extractTerminalLinks,
  resolvePathLinkTarget,
  splitPathAndPosition,
} from "../../../terminal-links";
import { iconForItemType } from "../workEntryIcons";
import { classifyCompactCommand, isGenericCommandTitle } from "@t3tools/shared/commandSummary";

export type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
export type TimelineWorkEntry = Extract<TimelineEntry, { kind: "work" }>["entry"];

export function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-destructive-foreground",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground",
  };
}

export function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-destructive-foreground";
  if (tone === "tool") return "text-muted-foreground";
  if (tone === "thinking") return "text-muted-foreground";
  return "text-muted-foreground";
}

interface WorkEntryChangedFilePreview {
  rawPath: string;
  targetPath: string;
  displayPath: string;
}

function resolveWorkEntryFilePreview(
  rawPath: string,
  executionCwd: string | undefined,
  workspaceRoot: string | undefined,
): WorkEntryChangedFilePreview {
  const targetPath = executionCwd ? resolvePathLinkTarget(rawPath, executionCwd) : rawPath;
  const { path } = splitPathAndPosition(targetPath);
  return {
    rawPath,
    targetPath,
    displayPath: relativePathForDisplay(path, workspaceRoot),
  };
}

export function changedFilesForPreview(
  workEntry: Pick<TimelineWorkEntry, "cwd" | "turnId" | "changedFiles">,
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
  /** False when the turn has other file changes, which would each claim all its files. */
  allowTurnFallback = true,
): WorkEntryChangedFilePreview[] | undefined {
  const directChangedFiles = workEntry.changedFiles;
  if (directChangedFiles && directChangedFiles.length > 0) {
    return directChangedFiles.map((filePath) =>
      resolveWorkEntryFilePreview(filePath, workEntry.cwd, workspaceRoot),
    );
  }
  if (!workEntry.turnId || !allowTurnFallback) {
    return undefined;
  }
  const turnSummary = turnDiffSummaryByTurnId.get(workEntry.turnId);
  if (!turnSummary || turnSummary.files.length === 0) {
    return undefined;
  }
  return turnSummary.files.map((file) =>
    resolveWorkEntryFilePreview(file.path, undefined, workspaceRoot),
  );
}

function formatChangedFilesPreview(
  changedFiles: ReadonlyArray<WorkEntryChangedFilePreview> | undefined,
) {
  if ((changedFiles?.length ?? 0) === 0) return null;
  const firstFile = changedFiles?.[0];
  if (!firstFile) return null;
  return changedFiles!.length === 1
    ? firstFile.displayPath
    : `${firstFile.displayPath} +${changedFiles!.length - 1} more`;
}

function normalizedReadWorkEntry(
  workEntry: Pick<TimelineWorkEntry, "command" | "lineSummary" | "readPaths">,
): {
  filePaths: ReadonlyArray<string>;
  lineSummary?: string;
} | null {
  if (workEntry.command) {
    const commandClassification = classifyCompactCommand(workEntry.command);
    if (commandClassification.kind === "file-read") {
      return {
        filePaths: commandClassification.fileRead.filePaths,
        ...(commandClassification.fileRead.lineSummary
          ? { lineSummary: commandClassification.fileRead.lineSummary }
          : {}),
      };
    }
  }

  if (!workEntry.readPaths || workEntry.readPaths.length === 0) {
    return null;
  }

  return {
    filePaths: workEntry.readPaths,
    ...(workEntry.lineSummary ? { lineSummary: workEntry.lineSummary } : {}),
  };
}

export function workEntryReadFilesForPreview(
  workEntry: Pick<TimelineWorkEntry, "command" | "lineSummary" | "readPaths">,
  executionCwd: string | undefined,
  workspaceRoot: string | undefined,
) {
  const readMatch = normalizedReadWorkEntry(workEntry);
  if (!readMatch) {
    return [];
  }
  return readMatch.filePaths.map((filePath) =>
    resolveWorkEntryFilePreview(filePath, executionCwd, workspaceRoot),
  );
}

function workEntryInlineFilePreview(
  workEntry: Pick<TimelineWorkEntry, "command" | "lineSummary" | "readPaths">,
  executionCwd: string | undefined,
  workspaceRoot: string | undefined,
): InlineFilePreview | null {
  const readMatch = normalizedReadWorkEntry(workEntry);
  if (!readMatch) {
    return null;
  }

  const primaryPath = readMatch.filePaths[0];
  if (!primaryPath) {
    return null;
  }

  const primaryFile = resolveWorkEntryFilePreview(primaryPath, executionCwd, workspaceRoot);
  const extraFilesSummary =
    readMatch.filePaths.length > 1 ? ` +${readMatch.filePaths.length - 1} more` : "";
  const lineSummary = readMatch.lineSummary ? ` (${readMatch.lineSummary})` : "";
  const trailingText = `${extraFilesSummary}${lineSummary}`;
  return {
    targetPath: primaryFile.targetPath,
    label: primaryFile.displayPath,
    text: `${primaryFile.displayPath}${trailingText}`,
    trailingText,
  };
}

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPositiveInteger(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const rawValue = record[key];
    if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue > 0) {
      return rawValue;
    }
    if (typeof rawValue === "string" && /^\d+$/.test(rawValue)) {
      const parsed = Number.parseInt(rawValue, 10);
      if (parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function parsePositiveIntegerString(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

function formatInlineFileReadPosition(input: {
  line: number | undefined;
  endLine: number | undefined;
  column: number | undefined;
}): string | null {
  if (!input.line) {
    return null;
  }
  if (input.column) {
    return `line ${input.line}:${input.column}`;
  }
  if (input.endLine && input.endLine > input.line) {
    return `lines ${input.line}-${input.endLine}`;
  }
  return `line ${input.line}`;
}

interface InlineFilePreview {
  targetPath: string;
  label: string;
  text: string;
  trailingText: string;
}

interface ParsedFileReadDetail {
  source: "structured" | "bare-path";
  rawPath: string;
  line: number | undefined;
  endLine: number | undefined;
  column: number | undefined;
}

function inferredFileOperationHeading(
  workEntry: Pick<
    TimelineWorkEntry,
    "detail" | "itemType" | "label" | "readPaths" | "requestKind" | "toolTitle"
  >,
): string | null {
  if (isFileReadWorkEntry(workEntry)) {
    return "File read";
  }
  if (isFileChangeWorkEntry(workEntry)) {
    return "File change";
  }
  if (
    workEntry.itemType !== "dynamic_tool_call" &&
    workEntry.itemType !== "mcp_tool_call" &&
    workEntry.itemType !== "file_change"
  ) {
    return null;
  }
  const detail = workEntry.detail?.trim();
  if (!detail) {
    return null;
  }
  if (/^read(?:\s+file)?\b/i.test(detail)) {
    return "File read";
  }
  if (/^(?:write|create|update|edit)(?:\s+file)?\b/i.test(detail)) {
    return "Write file";
  }
  return null;
}

export function parseFileReadDetail(detail: string): ParsedFileReadDetail | null {
  const trimmed = detail.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const jsonCandidates = new Set<string>([trimmed]);
  const firstBraceIndex = trimmed.indexOf("{");
  const lastBraceIndex = trimmed.lastIndexOf("}");
  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    jsonCandidates.add(trimmed.slice(firstBraceIndex, lastBraceIndex + 1));
  }

  for (const candidate of jsonCandidates) {
    let parsedDetail: unknown;
    try {
      parsedDetail = JSON.parse(candidate);
    } catch {
      continue;
    }

    const record = asUnknownRecord(parsedDetail);
    if (!record) {
      continue;
    }

    const rawPath = [
      record.file_path,
      record.filePath,
      record.relative_path,
      record.relativePath,
      record.path,
    ].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (!rawPath) {
      continue;
    }

    return {
      source: "structured",
      rawPath,
      line: readPositiveInteger(record, ["line", "lineNumber", "line_number", "start_line"]),
      endLine: readPositiveInteger(record, ["endLine", "end_line"]),
      column: readPositiveInteger(record, ["column", "columnNumber", "column_number"]),
    };
  }

  const pathMatches = extractTerminalLinks(trimmed).filter((match) => match.kind === "path");
  const pathMatch = pathMatches[0];
  if (!pathMatch || pathMatches.length !== 1) {
    return null;
  }
  if (pathMatch.start !== 0 || pathMatch.end !== trimmed.length) {
    return null;
  }

  const { path, line, column } = splitPathAndPosition(pathMatch.text);
  if (path.trim().length === 0) {
    return null;
  }

  return {
    source: "bare-path",
    rawPath: path,
    line: parsePositiveIntegerString(line),
    endLine: undefined,
    column: parsePositiveIntegerString(column),
  };
}

export function resolveInlineFilePreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "changedFiles"
    | "command"
    | "cwd"
    | "detail"
    | "itemType"
    | "label"
    | "lineSummary"
    | "readPaths"
    | "requestKind"
    | "toolTitle"
    | "turnId"
  >,
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
  allowTurnFallback = true,
): InlineFilePreview | null {
  const normalizedReadPreview = workEntryInlineFilePreview(workEntry, workEntry.cwd, workspaceRoot);
  if (normalizedReadPreview) {
    return normalizedReadPreview;
  }

  const changedFiles = changedFilesForPreview(
    workEntry,
    turnDiffSummaryByTurnId,
    workspaceRoot,
    allowTurnFallback,
  );
  const fileReadEntry = isFileReadWorkEntry(workEntry);
  const fileChangeEntry = isFileChangeWorkEntry(workEntry);
  if (
    !workEntry.command &&
    changedFiles &&
    changedFiles.length > 0 &&
    (fileReadEntry || fileChangeEntry)
  ) {
    const primaryFile = changedFiles[0];
    if (!primaryFile) {
      return null;
    }
    const suffix = fileReadEntry
      ? `${changedFiles.length > 1 ? ` +${changedFiles.length - 1} more` : ""}${
          workEntry.detail ? ` (${workEntry.detail})` : ""
        }`
      : changedFiles.length > 1
        ? ` +${changedFiles.length - 1} more`
        : "";
    return {
      targetPath: primaryFile.targetPath,
      label: primaryFile.displayPath,
      text: `${primaryFile.displayPath}${suffix}`,
      trailingText: suffix,
    };
  }

  if (!workEntry.detail) {
    return null;
  }

  const parsedDetail = parseFileReadDetail(workEntry.detail);
  if (!parsedDetail) {
    return null;
  }

  const allowsStructuredDetailPreview =
    fileReadEntry ||
    fileChangeEntry ||
    workEntry.itemType === "dynamic_tool_call" ||
    workEntry.itemType === "mcp_tool_call";
  const allowsBarePathDetailPreview = fileReadEntry || fileChangeEntry;
  if (
    (parsedDetail.source === "structured" && !allowsStructuredDetailPreview) ||
    (parsedDetail.source === "bare-path" && !allowsBarePathDetailPreview)
  ) {
    return null;
  }

  const positionSummary = formatInlineFileReadPosition({
    line: parsedDetail.line,
    endLine: parsedDetail.endLine,
    column: parsedDetail.column,
  });
  const rawTargetPath = parsedDetail.line
    ? `${parsedDetail.rawPath}:${parsedDetail.line}${parsedDetail.column ? `:${parsedDetail.column}` : ""}`
    : parsedDetail.rawPath;
  const resolvedFile = resolveWorkEntryFilePreview(rawTargetPath, workEntry.cwd, workspaceRoot);
  const trailingText = positionSummary ? ` (${positionSummary})` : "";
  return {
    targetPath: resolvedFile.targetPath,
    label: resolvedFile.displayPath,
    text: `${resolvedFile.displayPath}${trailingText}`,
    trailingText,
  };
}

export function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    | "detail"
    | "command"
    | "cwd"
    | "changedFiles"
    | "itemType"
    | "label"
    | "lineSummary"
    | "readPaths"
    | "requestKind"
    | "searchSummary"
    | "toolTitle"
    | "turnId"
  >,
  turnDiffSummaryByTurnId: Map<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
  allowTurnFallback = true,
) {
  const searchSummary = normalizedSearchSummary(workEntry);
  if (searchSummary) {
    return undefined;
  }
  if (workEntry.command) {
    return workEntry.command;
  }
  if (workEntry.itemType === "mcp_tool_call") return undefined;

  const changedFilesPreview = formatChangedFilesPreview(
    changedFilesForPreview(workEntry, turnDiffSummaryByTurnId, workspaceRoot, allowTurnFallback),
  );
  const isFileChangeRow =
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change" ||
    changedFilesPreview !== null;

  if (workEntry.requestKind === "file-read" && changedFilesPreview) {
    return workEntry.detail ? `${changedFilesPreview} (${workEntry.detail})` : changedFilesPreview;
  }

  if (isFileChangeRow && changedFilesPreview) {
    return changedFilesPreview;
  }
  const dynamicTool = describeDynamicToolEntry(workEntry);
  if (dynamicTool) return dynamicTool.preview ?? undefined;
  if (workEntry.detail) return workEntry.detail;
  return changedFilesPreview;
}

type TimelineEntryIcon = Icon | LucideIcon;

const DYNAMIC_TOOL_ICONS: Record<DynamicToolIconKind, LucideIcon> = {
  search: SearchIcon,
  web: GlobeIcon,
  tasks: ListTodoIcon,
  tool: HammerIcon,
};

export function workEntryIcon(workEntry: TimelineWorkEntry): TimelineEntryIcon {
  if (workEntry.requestKind === "command") {
    const commandClassification = workEntry.command
      ? classifyCompactCommand(workEntry.command)
      : { kind: "other" as const };
    if (commandClassification.kind === "file-read") {
      return EyeIcon;
    }
    if (commandClassification.kind === "search" || isSearchWorkEntry(workEntry)) {
      return SearchIcon;
    }
    return TerminalIcon;
  }
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    const commandClassification = workEntry.command
      ? classifyCompactCommand(workEntry.command)
      : { kind: "other" as const };
    if (commandClassification.kind === "file-read") {
      return EyeIcon;
    }
    if (commandClassification.kind === "search" || isSearchWorkEntry(workEntry)) {
      return SearchIcon;
    }
    return TerminalIcon;
  }
  if (isSearchWorkEntry(workEntry)) return SearchIcon;
  if (isFileReadWorkEntry(workEntry)) return EyeIcon;
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;
  if (workEntry.itemType === "image_generation") return ImageIcon;
  if (workEntry.itemType === "sleep") return ClockIcon;
  const dynamicTool = describeDynamicToolEntry(workEntry);
  if (dynamicTool) return DYNAMIC_TOOL_ICONS[dynamicTool.icon];

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return iconForItemType(workEntry.itemType);
    case "dynamic_tool_call":
      return iconForItemType(workEntry.itemType);
    case "collab_agent_tool_call":
      return iconForItemType(workEntry.itemType);
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function formatMcpIdentifier(value: string): string {
  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  if (normalized.length === 0) {
    return value;
  }
  return normalized
    .split(/\s+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

export function formatMcpToolHeading(workEntry: TimelineWorkEntry): string {
  if (workEntry.mcpServerName && workEntry.mcpToolName) {
    return `${formatMcpIdentifier(workEntry.mcpServerName)}: ${formatMcpIdentifier(
      workEntry.mcpToolName,
    )}`;
  }
  if (workEntry.mcpToolName) {
    return formatMcpIdentifier(workEntry.mcpToolName);
  }
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

function isGenericInferredActivityHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "tool call" || normalized === "reasoning update";
}

export function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  const computer = workEntry.computerTool
    ? computerToolHeading(workEntry.mcpToolName, workEntry.status)
    : undefined;
  if (computer) return `Computer · ${computer}`;
  const preview =
    classifyAutomationEntry(workEntry) === "preview"
      ? previewToolHeading(workEntry.mcpToolName, workEntry.status)
      : undefined;
  if (preview) return `Browser · ${preview}`;
  if (workEntry.itemType === "mcp_tool_call") {
    return `MCP Call - ${formatMcpToolHeading(workEntry)}`;
  }
  const searchSummary = normalizedSearchSummary(workEntry);
  if (searchSummary) {
    return searchSummary;
  }
  const normalizedHeading = normalizedWorkEntryHeading(workEntry);
  if (normalizedHeading.length === 0) {
    return capitalizePhrase(workEntry.label);
  }
  if (workEntry.command && isGenericCommandTitle(normalizedHeading)) {
    const commandClassification = classifyCompactCommand(workEntry.command);
    if (commandClassification.kind === "file-read") {
      return "File read";
    }
    if (commandClassification.kind === "search") {
      return commandClassification.summary;
    }
  }
  if (isGenericInferredActivityHeading(normalizedHeading)) {
    const inferredHeading = inferredFileOperationHeading(workEntry);
    if (inferredHeading) {
      return inferredHeading;
    }
    const dynamicTool = describeDynamicToolEntry(workEntry);
    if (dynamicTool) {
      return dynamicTool.heading;
    }
  }
  return capitalizePhrase(normalizedHeading);
}
