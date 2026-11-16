import { stripVTControlCharacters } from "node:util";

const ERROR_LINE = /^(?:[a-z]*error|fatal)(?: ?\[[^\]]+\])?:\s*\S/i;

export function appendStderrTail(current: string, chunk: string): string {
  return (current + chunk).slice(-8_192);
}

/** Prefer launcher errors to the stack frames or usage help that follow them. */
export function stderrExcerpt(tail: string): string | undefined {
  const lines = stripVTControlCharacters(tail)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const line = lines.findLast((candidate) => ERROR_LINE.test(candidate)) ?? lines.at(-1);
  return line === undefined || line.length <= 512 ? line : line.slice(0, 511) + "…";
}
