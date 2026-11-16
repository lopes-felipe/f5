import { realpathSync } from "node:fs";
import * as NodePath from "node:path";

/**
 * `permissions` for Claude's flag settings (`--settings`), sent on every launch.
 *
 * `blockReadsExemptPaths` keeps F5's attachments and plan files readable when a user or
 * org sets `blockReadsOutsideWorkingDirectories`; it allows nothing by itself, since the
 * normal permission checks still decide each read. Claude follows no links in these paths,
 * so every spelling (as configured and resolved) is listed.
 */
export function buildClaudeFlagPermissions(input: {
  readonly readExemptDirectories: ReadonlyArray<string | undefined>;
  readonly confineWritesToWorkspace?: boolean | undefined;
}): {
  blockReadsExemptPaths?: string[];
  blockWritesOutsideWorkingDirectories?: true;
} {
  const paths = new Set<string>();
  for (const directory of input.readExemptDirectories) {
    if (!directory || !NodePath.isAbsolute(directory)) continue;
    const spellings = [NodePath.resolve(directory)];
    try {
      spellings.push(realpathSync(directory));
    } catch {
      // Not created yet; the configured spelling is the one reads will use.
    }
    for (const spelling of spellings) {
      // Claude ignores filesystem roots; never send one.
      if (spelling !== NodePath.parse(spelling).root) paths.add(spelling);
    }
  }
  return {
    ...(paths.size ? { blockReadsExemptPaths: [...paths] } : {}),
    ...(input.confineWritesToWorkspace ? { blockWritesOutsideWorkingDirectories: true } : {}),
  };
}
