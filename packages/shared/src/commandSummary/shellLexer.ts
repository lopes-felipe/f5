import { SHELL_COMMAND_SEPARATORS, SHELL_TOKEN_OPERATORS } from "./constants";

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function readShellWord(command: string, start: number): string {
  let index = start;
  let quote: '"' | "'" | null = null;

  while (index < command.length) {
    const char = command[index];
    if (!char) {
      break;
    }

    if (quote === null) {
      if (isWhitespace(char)) {
        break;
      }
      if (SHELL_TOKEN_OPERATORS.some((operator) => command.startsWith(operator, index))) {
        break;
      }
      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }
      if (char === "\\") {
        index += Math.min(2, command.length - index);
        continue;
      }
      index += 1;
      continue;
    }

    if (char === quote) {
      quote = null;
      index += 1;
      continue;
    }
    if (quote === '"' && char === "\\") {
      index += Math.min(2, command.length - index);
      continue;
    }
    index += 1;
  }

  return command.slice(start, index);
}

export function lexShellCommand(command: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    if (!char) {
      break;
    }

    if (isWhitespace(char)) {
      const start = index;
      while (index < command.length && isWhitespace(command[index] ?? "")) {
        index += 1;
      }
      tokens.push(command.slice(start, index));
      continue;
    }

    const operator = SHELL_TOKEN_OPERATORS.find((candidate) =>
      command.startsWith(candidate, index),
    );
    if (operator) {
      tokens.push(operator);
      index += operator.length;
      continue;
    }

    const word = readShellWord(command, index);
    if (word.length === 0) {
      tokens.push(char);
      index += 1;
      continue;
    }
    tokens.push(word);
    index += word.length;
  }

  return tokens;
}

export function isShellOperatorToken(token: string): boolean {
  return SHELL_TOKEN_OPERATORS.includes(token as (typeof SHELL_TOKEN_OPERATORS)[number]);
}

export function isShellCommandSeparatorToken(token: string): boolean {
  return SHELL_COMMAND_SEPARATORS.has(token);
}
