import { isWindowsAbsolutePath } from "../local-paths";

interface DestinationCompileContext {
  readonly stack: ReadonlyArray<{ readonly type: string; url?: string }>;
  resume(): string;
  sliceSerialize(token: unknown): string;
}

function keepWindowsPathDestination(this: DestinationCompileContext, token: unknown) {
  const decoded = this.resume();
  const authored = this.sliceSerialize(token);
  const node = this.stack.at(-1);
  // Character references still need decoding, so those destinations keep the parsed URL.
  if (node)
    node.url = isWindowsAbsolutePath(authored) && !authored.includes("&") ? authored : decoded;
}

// A drive (`C:`) at `at`, at the start of the text or after a non-word character.
function isDriveAt(value: string, at: number): boolean {
  return (
    at >= 0 &&
    /[A-Za-z]/.test(value[at] ?? "") &&
    value[at + 1] === ":" &&
    (at === 0 || /\W/.test(value[at - 1]!))
  );
}

// Escapes that can start a path right after a bare drive: `C:\.claude`, `C:\\Users`, `C:\_build`.
// `Option A:\*bold\*` is prose, and `*` cannot appear in a Windows path.
const BARE_DRIVE_ESCAPE = /[\\/._$~-]/;

interface EscapeCompileContext {
  readonly stack: ReadonlyArray<{
    readonly type: string;
    children?: Array<{ type: string; value?: string }>;
  }>;
}

// Text nodes only grow while parsing. Each remembers how far it was scanned and whether its last
// word holds a drive path (`C:\`, `C:/`), so an escape only scans the text appended since the
// previous one. Rescanning the whole node made long paragraphs with many escapes quadratic.
const escapeScans = new WeakMap<object, { end: number; inPath: boolean }>();

// The escaped character has just been appended to the open text node.
function keepWindowsPathEscape(this: EscapeCompileContext) {
  const text = this.stack.at(-1)?.children?.at(-1);
  if (text?.type !== "text" || text.value === undefined) return;
  const value = text.value;
  const end = value.length - 1;
  let scan = escapeScans.get(text);
  if (!scan || scan.end > end) escapeScans.set(text, (scan = { end: 0, inPath: false }));
  for (let index = scan.end; index < end; index++) {
    const char = value[index]!;
    if (/\s/.test(char)) scan.inPath = false;
    else if ((char === "\\" || char === "/") && isDriveAt(value, index - 2)) scan.inPath = true;
  }
  // The escaped character is scanned with the next escape, after any restored backslash.
  scan.end = end;
  const escaped = value[end]!;
  if (scan.inPath || (isDriveAt(value, end - 2) && BARE_DRIVE_ESCAPE.test(escaped)))
    text.value = `${value.slice(0, end)}\\${escaped}`;
}

/**
 * CommonMark reads the `\.` in `C:\me\.claude\settings.json` as an escape. Every backslash
 * in a Windows path is a separator, so link, image, and definition destinations that are
 * Windows paths keep the text as written, and so do escapes inside drive paths in prose.
 * Prose paths end at whitespace: past that, nothing tells a path from a sentence, and
 * `C:\x and \*this\*` must still read `*this*`.
 */
export function remarkKeepWindowsPaths(this: unknown) {
  // `this` is the unified processor; apps/web does not depend on unified's types directly.
  const data = (this as { data(): { fromMarkdownExtensions?: unknown[] } }).data();
  (data.fromMarkdownExtensions ??= []).push({
    exit: {
      resourceDestinationString: keepWindowsPathDestination,
      definitionDestinationString: keepWindowsPathDestination,
      characterEscape: keepWindowsPathEscape,
    },
  });
}
