import {
  POSIX_SHELL_NAMES,
  COMMAND_TOOL_NAMES,
  type ComparableCommandExecutionLike,
} from "./constants";
import { isShellOperatorToken, lexShellCommand } from "./shellLexer";

export type CommandExecutionBackgroundStatus = "running" | "completed" | "failed" | "stopped";

export interface ParsedCommandExecutionTitle {
  readonly baseTitle: string;
  readonly backgroundStatus: CommandExecutionBackgroundStatus | null;
}

// Claude retitles backgrounded tools as "<title> — <status>" (see the Claude
// adapter's backgroundToolTitle); the suffix is the only stored background marker.
export const BACKGROUND_TITLE_PATTERN = /^(.*\S)\s+—\s+(running|completed|failed|stopped)$/s;

export function parseCommandExecutionTitle(title: string): ParsedCommandExecutionTitle {
  const trimmed = title.trim();
  const match = BACKGROUND_TITLE_PATTERN.exec(trimmed);
  if (!match?.[1] || !match[2]) {
    return { baseTitle: trimmed, backgroundStatus: null };
  }
  return {
    baseTitle: match[1],
    backgroundStatus: match[2] as CommandExecutionBackgroundStatus,
  };
}

export function commandExecutionBackgroundStatus(
  execution: Pick<ComparableCommandExecutionLike, "title">,
): CommandExecutionBackgroundStatus | null {
  return execution.title ? parseCommandExecutionTitle(execution.title).backgroundStatus : null;
}

export function isGenericCommandTitle(title: string): boolean {
  return /^(?:ran|running) command$|^command run$/i.test(
    parseCommandExecutionTitle(title).baseTitle,
  );
}

export function shellBasename(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] ?? normalized;
}

export function unwrapShellCommandArg(value: string): string {
  if (value.length < 2) {
    return value;
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'"'"'/g, "'");
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(["\\$`])/g, "$1")
      .replace(/\\n/g, "\n");
  }

  return value;
}

export function isQuotedToken(token: string): boolean {
  return (
    token.length >= 2 &&
    ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"')))
  );
}

export function isCommandSubstitutionToken(token: string): boolean {
  return /^\$\(.+\)$/.test(token) || /^`[^`]+`$/.test(token);
}

export function maybeUnquoteShellToken(token: string): string {
  return isQuotedToken(token) ? unwrapShellCommandArg(token) : token;
}

// Codex can serialize a single argv value as adjacent single/double-quoted
// fragments. Decode only that complete transport form, never PowerShell escapes.
export function unwrapQuotedCommandFragments(value: string): string | null {
  let offset = 0;
  let fragments = 0;
  let result = "";
  while (offset < value.length) {
    const quote = value[offset++];
    if (quote !== "'" && quote !== '"') return null;
    let closed = false;
    while (offset < value.length) {
      const char = value[offset++];
      if (char === quote) {
        closed = true;
        break;
      }
      if (quote === '"' && char === "\\" && /["\\$`]/.test(value[offset] ?? "")) {
        result += value[offset++];
      } else {
        result += char;
      }
    }
    if (!closed) return null;
    fragments += 1;
  }
  return fragments > 1 ? result : null;
}

export function displayPowerShellCommand(command: string): string | null {
  const match =
    /^(?:"(?<doubleQuotedShell>[^"]+)"|'(?<singleQuotedShell>[^']+)'|(?<shell>[^\s"']+))\s+(?<args>.+)$/s.exec(
      command.trim(),
    );
  const shell =
    match?.groups?.doubleQuotedShell ?? match?.groups?.singleQuotedShell ?? match?.groups?.shell;
  const args = match?.groups?.args;
  if (!shell || !args || !/^(?:powershell|pwsh)(?:\.exe)?$/i.test(shellBasename(shell))) {
    return null;
  }

  const invocation =
    /^(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+|-ExecutionPolicy\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s\-"']+)\s+)*-(?:Command|c)\s+(?<body>.+)$/is.exec(
      args,
    );
  const body = invocation?.groups?.body?.trim();
  if (!body || body === "-") {
    return null;
  }

  // Provider command strings already contain the script text. Only remove its
  // enclosing quotes: POSIX unescaping would corrupt Windows paths and scripts.
  if (body.startsWith("'") || body.startsWith('"')) {
    const fragments = unwrapQuotedCommandFragments(body);
    if (fragments !== null) return fragments || null;
    return isQuotedToken(body) && body.length > 2 ? body.slice(1, -1) : null;
  }
  return body;
}

export function displayCommandExecutionCommand(command: string): string {
  const powerShellCommand = displayPowerShellCommand(command);
  if (powerShellCommand !== null) {
    return powerShellCommand;
  }
  const windows = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+(.+)$/s.exec(command.trim());
  const executable = windows?.[1] ?? windows?.[2] ?? windows?.[3];
  if (executable && /^cmd(?:\.exe)?$/i.test(shellBasename(executable))) {
    const tokens = lexShellCommand(windows![4]!).filter((token) => token.trim().length > 0);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.toLowerCase() === "/c") {
        // Keep launchers with positional arguments or shell operators intact.
        if (index === tokens.length - 2) {
          const script = tokens[index + 1]!;
          if (isShellOperatorToken(script)) break;
          return isQuotedToken(script) ? script.slice(1, -1) || command : script;
        }
        break;
      }
      if (!token.startsWith("/")) break;
    }
    return command;
  }
  const match = /^(?<shell>\S+)\s+(?<flag>-(?:ilc|lc|ic|c))\s+(?<rest>.+)$/s.exec(command.trim());
  const shell = match?.groups?.shell;
  const rest = match?.groups?.rest;
  if (!shell || !rest) {
    return command;
  }

  if (!POSIX_SHELL_NAMES.has(shellBasename(shell))) {
    return command;
  }

  return unwrapShellCommandArg(rest.trim());
}

export function extractCommandToolSummaryPayload(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = /^(?<tool>[A-Za-z][A-Za-z0-9 _-]*):\s*(?<payload>.+)$/s.exec(value.trim());
  if (!match?.groups) {
    return null;
  }

  const { tool, payload: rawPayload } = match.groups;
  if (tool === undefined || rawPayload === undefined) {
    return null;
  }

  const toolName = tool.trim().toLowerCase();
  if (!COMMAND_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const payload = rawPayload.trim();
  if (payload.length === 0 || /^\{\s*\}$/.test(payload)) {
    return null;
  }

  if (payload.startsWith("{") && payload.endsWith("}")) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const command =
        typeof parsed.command === "string"
          ? parsed.command
          : typeof parsed.cmd === "string"
            ? parsed.cmd
            : null;
      const trimmed = command?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  return payload;
}

export function isUnhelpfulCommandSummary(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    /^(?:[A-Za-z][A-Za-z0-9 _-]*:\s*\{\s*\}|\[command unavailable\])$/s.test(trimmed)
  );
}

export function normalizeCommandExecutionDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) {
    return null;
  }
  const payload = extractCommandToolSummaryPayload(detail);
  return payload === null ? detail : displayCommandExecutionCommand(payload);
}

export function resolveCommandExecutionDisplayCommand(
  execution: Pick<ComparableCommandExecutionLike, "command" | "detail">,
): string {
  const detailSummary = extractCommandToolSummaryPayload(execution.detail);
  if (detailSummary) {
    const commandSummary = extractCommandToolSummaryPayload(execution.command);
    if (
      !commandSummary ||
      isUnhelpfulCommandSummary(execution.command) ||
      commandSummary !== detailSummary
    ) {
      return displayCommandExecutionCommand(detailSummary);
    }
  }

  return displayCommandExecutionCommand(
    extractCommandToolSummaryPayload(execution.command) ?? execution.command,
  );
}
