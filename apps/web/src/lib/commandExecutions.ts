import type {
  OrchestrationCommandExecution,
  OrchestrationCommandExecutionSummary,
} from "@t3tools/contracts";
import {
  isShellCommandSeparatorToken,
  isShellOperatorToken,
  lexShellCommand,
} from "@t3tools/shared/commandSummary";

export {
  detectFileReadCommand,
  displayCommandExecutionCommand,
  normalizeCommandExecutionDetail,
  resolveCommandExecutionDisplayCommand,
  resolveCommandExecutionSummaryText,
} from "@t3tools/shared/commandSummary";

type ComparableCommandExecution =
  | OrchestrationCommandExecution
  | OrchestrationCommandExecutionSummary;

export function compareCommandExecutions(
  left: ComparableCommandExecution,
  right: ComparableCommandExecution,
): number {
  return (
    left.startedAt.localeCompare(right.startedAt) ||
    left.startedSequence - right.startedSequence ||
    left.id.localeCompare(right.id)
  );
}

export type DisplayCommandTokenKind =
  | "text"
  | "whitespace"
  | "command"
  | "flag"
  | "string"
  | "operator"
  | "env"
  | "path"
  | "variable"
  | "number"
  | "substitution";

export interface DisplayCommandToken {
  readonly text: string;
  readonly kind: DisplayCommandTokenKind;
}

function isQuotedToken(token: string): boolean {
  return (
    token.length >= 2 &&
    ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"')))
  );
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isVariableToken(token: string): boolean {
  return /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])$/.test(token);
}

function isCommandSubstitutionToken(token: string): boolean {
  return /^\$\(.+\)$/.test(token) || /^`[^`]+`$/.test(token);
}

function isNumericToken(token: string): boolean {
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(token);
}

function isPathToken(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(token)
  );
}

export function tokenizeDisplayCommand(command: string): ReadonlyArray<DisplayCommandToken> {
  const tokens = lexShellCommand(command);
  const highlighted: DisplayCommandToken[] = [];
  let expectCommand = true;

  for (const token of tokens) {
    if (token.trim().length === 0) {
      highlighted.push({ text: token, kind: "whitespace" });
      continue;
    }

    if (isShellOperatorToken(token)) {
      highlighted.push({ text: token, kind: "operator" });
      if (isShellCommandSeparatorToken(token)) {
        expectCommand = true;
      }
      continue;
    }

    if (expectCommand && isEnvAssignmentToken(token)) {
      highlighted.push({ text: token, kind: "env" });
      continue;
    }

    if (expectCommand) {
      highlighted.push({ text: token, kind: "command" });
      expectCommand = false;
      continue;
    }

    if (token.startsWith("-")) {
      highlighted.push({ text: token, kind: "flag" });
      continue;
    }

    if (isCommandSubstitutionToken(token)) {
      highlighted.push({ text: token, kind: "substitution" });
      continue;
    }

    if (isVariableToken(token)) {
      highlighted.push({ text: token, kind: "variable" });
      continue;
    }

    if (isQuotedToken(token)) {
      highlighted.push({ text: token, kind: "string" });
      continue;
    }

    if (isEnvAssignmentToken(token)) {
      highlighted.push({ text: token, kind: "env" });
      continue;
    }

    if (isPathToken(token)) {
      highlighted.push({ text: token, kind: "path" });
      continue;
    }

    if (isNumericToken(token)) {
      highlighted.push({ text: token, kind: "number" });
      continue;
    }

    highlighted.push({ text: token, kind: "text" });
  }

  return highlighted;
}
