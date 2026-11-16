/**
 * Repo-relative globs whose uncommitted changes Storage cleanup may discard.
 * `**` crosses directories, `*` and `?` stay within one segment, and a
 * trailing `/` matches the directory and everything under it.
 */
interface DisposableMatcher {
  readonly regex: RegExp;
  /** True when a match also covers everything under the matched path. */
  readonly coversSubtree: boolean;
}

function compileGlob(pattern: string): DisposableMatcher {
  const directory = pattern.endsWith("/");
  const body = pattern.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  let source = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char === "*") {
      if (body[index + 1] === "*") {
        const slashAfter = body[index + 2] === "/";
        // `**/` also matches zero directories.
        source += slashAfter ? "(?:.*/)?" : ".*";
        index += slashAfter ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return {
    regex: new RegExp(`^${source}${directory ? "(?:/.*)?" : ""}$`),
    coversSubtree: directory || body.endsWith("**"),
  };
}

/** Paths that are not covered by any disposable pattern; empty means all may be discarded. */
export function nonDisposablePaths(
  paths: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const matchers = patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map(compileGlob);
  return paths.filter((path) => {
    // A wholly untracked directory is reported once, with a trailing slash, and
    // stands for its whole subtree: only a pattern covering that subtree
    // (a trailing `/` or `**`) may discard it.
    const isDirectory = path.endsWith("/");
    const normalized = path.replace(/\/+$/, "");
    return !matchers.some((matcher) =>
      isDirectory
        ? matcher.coversSubtree &&
          (matcher.regex.test(normalized) || matcher.regex.test(`${normalized}/`))
        : matcher.regex.test(normalized),
    );
  });
}
