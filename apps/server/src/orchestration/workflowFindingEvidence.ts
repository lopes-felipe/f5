import { posix, win32 } from "node:path";
import type { WorkflowReviewTarget } from "@t3tools/contracts";
import type { Finding, Disposition } from "./workflowFindingProtocol.ts";

type Correction = NonNullable<Disposition["correction"]>;

export function workspaceRelativeEvidencePath(value: string, root: string): string | null {
  const windows = win32.isAbsolute(root) && !posix.isAbsolute(root);
  const paths = windows ? win32 : posix;
  const relative = paths.relative(root, paths.resolve(root, value.replaceAll("\\", "/")));
  if (
    !relative ||
    paths.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(".." + paths.sep)
  )
    return null;
  return relative.replaceAll("\\", "/");
}

export function isWithinEvidenceWorkspace(value: string, root: string): boolean {
  const paths = win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix;
  if (!paths.isAbsolute(value)) return false;
  return paths.relative(root, value) === "" || workspaceRelativeEvidencePath(value, root) !== null;
}

function normalizedLines(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function hasExcerpt(text: string, excerpt: string): boolean {
  return ("\n" + normalizedLines(text) + "\n").includes("\n" + excerpt + "\n");
}

function quotedCorrection(finding: Finding, correction: Correction) {
  const before = normalizedLines(correction.before);
  const after = normalizedLines(correction.after);
  if (
    !before ||
    !after ||
    before === after ||
    !normalizedLines(finding.evidence ?? "").includes(before)
  )
    return null;
  return { before, after };
}

export function findingFileLocation(finding: Finding, workspace: string) {
  const location = /^(.+?):(\d+)(?::\d+)?(?:-\d+)?$/.exec(finding.location?.trim() ?? "");
  if (!location) return null;
  const path = workspaceRelativeEvidencePath(location[1]!, workspace);
  const line = Number(location[2]);
  return path && Number.isSafeInteger(line) && line > 0 ? { path, line } : null;
}

export function verifiesPlanCorrection(
  finding: Finding,
  correction: Correction,
  original: string,
  revised: string,
): boolean {
  const excerpts = quotedCorrection(finding, correction);
  const section = finding.location
    ?.replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
  if (!excerpts || !section) return false;
  const sectionText = (markdown: string) => {
    const sections = markdown.split(/(?=^#{1,6}\s)/m).filter(
      (part) =>
        part
          .split(/\r?\n/, 1)[0]
          ?.replace(/^#+\s*/, "")
          .trim()
          .toLowerCase() === section,
    );
    return sections.length === 1 ? sections[0]! : "";
  };
  const oldSection = sectionText(original);
  const newSection = sectionText(revised);
  return (
    hasExcerpt(oldSection, excerpts.before) &&
    !hasExcerpt(newSection, excerpts.before) &&
    hasExcerpt(newSection, excerpts.after)
  );
}

export function verifiesPatchCorrection(
  finding: Finding,
  correction: Correction,
  patch: string,
  workspace: string,
): boolean {
  const excerpts = quotedCorrection(finding, correction);
  const location = findingFileLocation(finding, workspace);
  if (!excerpts || !location) return false;
  const { path, line } = location;
  const excerptLength = excerpts.before.split("\n").length;
  for (const file of patch.split(/(?=^diff --git )/m)) {
    const source = /^--- (.+)$/m.exec(file)?.[1]?.trim();
    if (
      !source ||
      source.startsWith('"') ||
      workspaceRelativeEvidencePath(source.replace(/^a\//, ""), workspace) !== path
    )
      continue;
    for (const hunk of file.split(/(?=^@@ -)/m)) {
      const rows = hunk.split(/\r?\n/);
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(rows[0] ?? "");
      if (!header) continue;
      let oldLine = Number(header[1]);
      let removed: string[] = [];
      let added: string[] = [];
      let removedAt = oldLine;
      const matches = () => {
        const offset = line - removedAt;
        if (offset < 0 || offset >= removed.length || !hasExcerpt(added.join("\n"), excerpts.after))
          return false;
        const first = Math.max(0, offset - excerptLength + 1);
        const last = Math.min(offset, removed.length - excerptLength);
        for (let index = first; index <= last; index++) {
          if (
            normalizedLines(removed.slice(index, index + excerptLength).join("\n")) ===
            excerpts.before
          )
            return true;
        }
        return false;
      };
      for (const row of rows.slice(1)) {
        if (row.startsWith("-")) {
          if (removed.length === 0) removedAt = oldLine;
          removed.push(row.slice(1));
          oldLine++;
        } else if (row.startsWith("+")) {
          added.push(row.slice(1));
        } else if (row.startsWith(" ")) {
          if (matches()) return true;
          removed = [];
          added = [];
          oldLine++;
        }
      }
      if (matches()) return true;
    }
  }
  return false;
}

export function verifiesTargetedTest(
  command: string,
  output: string,
  testCase: string,
  target?: WorkflowReviewTarget | null,
): boolean {
  const escaped = testCase.replace(/[.*+?^{}()|[\]\\]/g, "\\$&");
  const selector = new RegExp(
    "(?:\\s(?:--testNamePattern|-t|-k|--filter|-run)(?:[=\\s]+)|::)[\"']?" +
      escaped +
      "(?=[\"'\\s]|$)",
  );
  const lastCommand = command.split(/\s&&\s/).at(-1) ?? "";
  if (
    !/^(?:(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+test\b|(?:bunx|npx)\s+(?:vitest|jest)\b|(?:pytest|vitest|jest|ctest|rspec|go test)\b)/i.test(
      lastCommand,
    ) ||
    !selector.test(lastCommand) ||
    !output.includes(testCase)
  )
    return false;
  if (!target) return true;
  if (
    !output
      .split(/\r?\n/)
      .some(
        (line) =>
          line.includes(testCase) && /(?:\bFAIL(?:ED)?\b|\bAssertionError\b|[×✕✗])/.test(line),
      )
  )
    return false;
  const firstLine = output.trimStart().split(/\r?\n/, 1)[0]?.split(/\s+/, 1)[0];
  return Boolean(
    (target.headRevision &&
      firstLine === target.headRevision &&
      /^git rev-parse (?:--verify )?HEAD\s+&&\s/.test(command)) ||
    (target.patchHash &&
      !target.truncated &&
      firstLine === target.patchHash &&
      /^git diff\b[^&]*\|\s*sha256sum\s+&&\s/.test(command)),
  );
}
