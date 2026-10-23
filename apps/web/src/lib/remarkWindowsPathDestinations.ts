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

/**
 * CommonMark reads the `\.` in `C:\me\.claude\settings.json` as an escape, even in a link
 * destination. Every backslash in a Windows path is a separator, so link, image, and
 * definition destinations that are Windows paths keep the text as written.
 */
export function remarkKeepWindowsPathDestinations(this: unknown) {
  // `this` is the unified processor; apps/web does not depend on unified's types directly.
  const data = (this as { data(): { fromMarkdownExtensions?: unknown[] } }).data();
  (data.fromMarkdownExtensions ??= []).push({
    exit: {
      resourceDestinationString: keepWindowsPathDestination,
      definitionDestinationString: keepWindowsPathDestination,
    },
  });
}
