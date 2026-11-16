// @effect-diagnostics nodeBuiltinImport:off
// Prints what the next stable release section would contain: CHANGELOG.md's Unreleased entries
// plus the pending fragments under changes/, merged exactly as release preparation merges them.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addFragments,
  readFragments,
  renderSection,
  unreleasedGroups,
} from "./lib/changelog-fragments.ts";
import { splitShippedFragments } from "./prepare-release.ts";

export function previewChangelog(root: string): string {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const { pending, shipped } = splitShippedFragments(root, readFragments(root));
  const section = renderSection(addFragments(unreleasedGroups(changelog), pending));
  const note = shipped
    ? `\n\nAlready released in ${shipped.version}; the next preparation adds them to its section: ` +
      shipped.fragments.map((fragment) => fragment.path).join(", ")
    : "";
  return (section || "No unreleased changes.") + note;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(previewChangelog(process.cwd()));
}
