/**
 * ANSI escape handling for command output. SGR sequences (colors and text
 * attributes) become styled spans; every other escape sequence is dropped.
 */

export type AnsiColor =
  | { readonly kind: "palette"; readonly index: number }
  | { readonly kind: "rgb"; readonly value: string };

export interface AnsiStyle {
  readonly fg?: AnsiColor;
  readonly bg?: AnsiColor;
  readonly bold?: true;
  readonly dim?: true;
  readonly italic?: true;
  readonly underline?: true;
}

export interface AnsiSpan {
  readonly text: string;
  readonly style: AnsiStyle | null;
}

export interface ParsedAnsiOutput {
  /** The output with every escape sequence removed. */
  readonly text: string;
  /** Styled spans per line of `text`; line breaks are not included. */
  readonly lines: ReadonlyArray<ReadonlyArray<AnsiSpan>>;
}

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and the
// remaining two-byte escapes.
const ESCAPE_PATTERN =
  // oxlint-disable-next-line no-control-regex
  /\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;
// oxlint-disable-next-line no-control-regex
const ESCAPE_PRESENT_PATTERN = /\x1b[[\]]/;

export function hasAnsiEscapes(output: string): boolean {
  return ESCAPE_PRESENT_PATTERN.test(output);
}

export function stripAnsi(output: string): string {
  return output.includes("\x1b") ? output.replace(ESCAPE_PATTERN, "") : output;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function hex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
}

function rgb(red: number, green: number, blue: number): AnsiColor {
  return { kind: "rgb", value: `#${hex(red)}${hex(green)}${hex(blue)}` };
}

/** xterm 256-color index; 0–15 stay theme palette colors. */
export function ansi256Color(index: number): AnsiColor | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < 16) return { kind: "palette", index };
  if (index < 232) {
    const cube = index - 16;
    return rgb(
      CUBE_LEVELS[Math.floor(cube / 36)]!,
      CUBE_LEVELS[Math.floor(cube / 6) % 6]!,
      CUBE_LEVELS[cube % 6]!,
    );
  }
  const gray = 8 + (index - 232) * 10;
  return rgb(gray, gray, gray);
}

type MutableStyle = {
  -readonly [Key in keyof AnsiStyle]?: AnsiStyle[Key];
};

/** Reads an extended color (`5;n` or `2;r;g;b`) starting at `params[index]`. */
function readExtendedColor(
  params: ReadonlyArray<number>,
  index: number,
): { color: AnsiColor | null; next: number } {
  const mode = params[index];
  if (mode === 5) {
    return { color: ansi256Color(params[index + 1] ?? -1), next: index + 2 };
  }
  if (mode === 2) {
    const [red, green, blue] = [params[index + 1], params[index + 2], params[index + 3]];
    const valid = [red, green, blue].every(
      (value) => value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255,
    );
    return { color: valid ? rgb(red!, green!, blue!) : null, next: index + 4 };
  }
  return { color: null, next: params.length };
}

export function applySgr(style: AnsiStyle, rawParams: string): AnsiStyle {
  const params =
    rawParams.length === 0
      ? [0]
      : rawParams.split(/[;:]/).map((part) => (part === "" ? 0 : Number.parseInt(part, 10)));
  const next: MutableStyle = { ...style };
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]!;
    if (Number.isNaN(code)) continue;
    if (code === 0) {
      for (const key of Object.keys(next) as Array<keyof MutableStyle>) delete next[key];
    } else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code >= 30 && code <= 37) next.fg = { kind: "palette", index: code - 30 };
    else if (code >= 90 && code <= 97) next.fg = { kind: "palette", index: code - 90 + 8 };
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = { kind: "palette", index: code - 40 };
    else if (code >= 100 && code <= 107) next.bg = { kind: "palette", index: code - 100 + 8 };
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const { color, next: nextIndex } = readExtendedColor(params, index + 1);
      if (color) {
        if (code === 38) next.fg = color;
        else next.bg = color;
      }
      index = nextIndex - 1;
    }
  }
  return next;
}

function isEmptyStyle(style: AnsiStyle): boolean {
  return Object.keys(style).length === 0;
}

export function parseAnsiOutput(output: string): ParsedAnsiOutput {
  const lines: AnsiSpan[][] = [[]];
  let style: AnsiStyle = {};
  let text = "";
  const pushText = (chunk: string) => {
    if (chunk.length === 0) return;
    text += chunk;
    const parts = chunk.split("\n");
    parts.forEach((part, partIndex) => {
      if (partIndex > 0) lines.push([]);
      if (part.length === 0) return;
      const line = lines[lines.length - 1]!;
      const spanStyle = isEmptyStyle(style) ? null : style;
      const previous = line[line.length - 1];
      if (previous && previous.style === spanStyle) {
        line[line.length - 1] = { text: previous.text + part, style: spanStyle };
      } else {
        line.push({ text: part, style: spanStyle });
      }
    });
  };
  let lastIndex = 0;
  for (const match of output.matchAll(ESCAPE_PATTERN)) {
    pushText(output.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    if (match[2] === "m" && match[0].startsWith("\x1b[")) {
      style = applySgr(style, match[1] ?? "");
    }
  }
  pushText(output.slice(lastIndex));
  return { text, lines };
}
