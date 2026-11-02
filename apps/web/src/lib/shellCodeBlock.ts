/** Keep executable source identical to the text the user sees. */
export function runnableShellCode(language: string, source: string): string | null {
  if (!/^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/.test(language)) return null;
  if (source.length > 32_000) return null;
  const command = source.trim();
  if (!command || command.endsWith("\\")) return null;
  // Newlines and tabs are meaningful shell syntax. Other controls, format and
  // invisible tag characters can conceal a different command in the terminal.
  if (/[\p{Cc}\p{Cf}]/u.test(source.replace(/[\n\t]/g, ""))) return null;
  return command;
}

/**
 * Whether the fence spanning `text[start, end)` has a real closer. `code` is the parsed
 * code text. Never offer to execute or render a truncated or unterminated fence.
 */
export function hasClosedCodeFence(
  text: string,
  start: number | undefined,
  end: number | undefined,
  code: string,
): boolean {
  if (start === undefined || end === undefined) return false;
  const source = text.slice(start, end);
  const opening = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
  const closing = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(source)?.[1];
  return (
    !!opening &&
    !!closing &&
    opening[0] === closing[0] &&
    closing.length >= opening.length &&
    // Only a real closer is left out of the parsed code. An overindented marker stays in it,
    // and a CRLF stream cut after CR must not count as an extra source line.
    lineCount(source.replace(/\r$/, "")) > lineCount(code)
  );
}

function lineCount(value: string): number {
  return value.split(/\r\n|\r|\n/).length;
}
