// @effect-diagnostics nodeBuiltinImport:off
// Prints what the next stable release section would contain: CHANGELOG.md's Unreleased entries
// plus every fragment under changes/, merged exactly as prepareChangelog merges them.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addFragments,
  readFragments,
  renderSection,
  unreleasedGroups,
} from "./lib/changelog-fragments.ts";

export function previewChangelog(root: string): string {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const section = renderSection(addFragments(unreleasedGroups(changelog), readFragments(root)));
  return section || "No unreleased changes.";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(previewChangelog(process.cwd()));
}
