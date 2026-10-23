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

/** Never offer to execute a truncated or unterminated fence. */
export function hasClosedCodeFence(
  text: string,
  start: number | undefined,
  end: number | undefined,
): boolean {
  if (start === undefined || end === undefined) return false;
  const source = text.slice(start, end);
  const opening = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
  const closing = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[ \t\r]*$/.exec(source)?.[1];
  return !!opening && !!closing && opening[0] === closing[0] && closing.length >= opening.length;
}
