import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DOCS = [
  "README.md",
  "ARCHITECTURE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "KEYBINDINGS.md",
  "NOTICE.md",
  "REMOTE.md",
  "SECURITY.md",
] as const;

/** Archive / generated subdirectories under `docs/` that are excluded from active link checks. */
const SKIPPED_DOCS_SUBDIRS = new Set(["reviews", "computer-certification", "images", "internals"]);

const DRIVER_TO_DOC_LABEL: Readonly<Record<string, string>> = {
  CodexDriver: "Codex",
  ClaudeDriver: "Claude Code",
  CursorDriver: "Cursor",
  OpenCodeDriver: "OpenCode",
  GrokDriver: "Grok",
  AntigravityDriver: "Antigravity",
  MuseDriver: "Muse Code",
  PiDriver: "Pi",
  AcpDriver: "Custom ACP",
};

/**
 * Strips CommonMark inline code spans within a single non-fenced paragraph
 * block in linear time, allowing spans to cross line endings inside the block.
 */
function stripInlineCodeInBlock(block: string): string {
  const runs: Array<{ readonly start: number; readonly end: number; readonly len: number }> = [];
  for (let i = 0; i < block.length; ) {
    if (block[i] !== "`") {
      i += 1;
      continue;
    }
    const start = i;
    while (i < block.length && block[i] === "`") i += 1;
    runs.push({ start, end: i, len: i - start });
  }
  if (runs.length < 2) return block;

  const byLen = new Map<number, number[]>();
  for (let idx = 0; idx < runs.length; idx += 1) {
    const len = runs[idx]!.len;
    const list = byLen.get(len);
    if (list) list.push(idx);
    else byLen.set(len, [idx]);
  }
  const cursorByLen = new Map<number, number>();

  let out = "";
  let pos = 0;
  for (let i = 0; i < runs.length; ) {
    const run = runs[i]!;
    const indices = byLen.get(run.len)!;
    let cursor = cursorByLen.get(run.len) ?? 0;
    while (cursor < indices.length && indices[cursor]! <= i) cursor += 1;
    cursorByLen.set(run.len, cursor);

    if (cursor < indices.length) {
      const closeIdx = indices[cursor]!;
      out += block.slice(pos, run.start);
      pos = runs[closeIdx]!.end;
      i = closeIdx + 1;
    } else {
      i += 1;
    }
  }
  out += block.slice(pos);
  return out;
}

/**
 * Strips fenced code blocks (CommonMark rules: closing fence must use the same
 * character, at least the opener's length, and only trailing whitespace) and
 * inline code spans (including multiline spans within a block) so example links
 * inside code are ignored.
 */
export function stripCodeBlocksAndInlineCode(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const blocks: string[][] = [[]];
  let activeFence: { readonly char: string; readonly length: number } | null = null;

  const pushBlockBoundary = () => {
    if (blocks.at(-1)!.length > 0) {
      blocks.push([]);
    }
  };

  for (const line of lines) {
    if (activeFence === null) {
      const openMatch = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
      if (openMatch?.[1]) {
        const marker = openMatch[1];
        const char = marker[0]!;
        // CommonMark: backtick info strings cannot contain backticks.
        if (char !== "`" || !line.slice(openMatch[0].length).includes("`")) {
          activeFence = { char, length: marker.length };
          pushBlockBoundary();
          continue;
        }
      }
      if (/^[ \t]*$/.test(line)) {
        pushBlockBoundary();
        continue;
      }
      blocks.at(-1)!.push(line);
    } else {
      const closePattern = new RegExp(
        `^[ ]{0,3}${activeFence.char}{${activeFence.length},}[ \\t]*$`,
      );
      if (closePattern.test(line)) {
        activeFence = null;
      }
    }
  }

  return blocks
    .filter((block) => block.length > 0)
    .map((block) => stripInlineCodeInBlock(block.join("\n")))
    .join("\n\n");
}

/**
 * Extracts inline and reference-style markdown link targets while supporting
 * CommonMark angle-bracketed destinations (`<...>`) and one level of balanced
 * parentheses (e.g. `foo(bar).md`) without nested quantifiers.
 */
export function extractMarkdownLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const cleaned = stripCodeBlocksAndInlineCode(markdown);
  const inlinePattern =
    /!?\[[^\]]*\]\([ \t]*(?:<([^<>\r\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:[ \t]+(?:"[^"]*"|'[^']*'))?[ \t]*\)/g;
  for (const match of cleaned.matchAll(inlinePattern)) {
    const rawTarget = match[1] ?? match[2];
    if (rawTarget) targets.push(rawTarget);
  }
  const referenceDefPattern = /^[ ]{0,3}\[[^\]]+\]:[ \t]*(?:<([^>\r\n]+)>|([^\s]+))/gm;
  for (const match of cleaned.matchAll(referenceDefPattern)) {
    const rawTarget = match[1] ?? match[2];
    if (rawTarget) targets.push(rawTarget);
  }
  return targets;
}

function decodeLinkPathname(rawPathname: string): string {
  try {
    return decodeURIComponent(rawPathname);
  } catch {
    return rawPathname;
  }
}

function collectActiveMarkdownFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const rel of ROOT_DOCS) {
    const abs = path.join(repoRoot, rel);
    if (existsSync(abs)) files.push(abs);
  }
  const walk = (dir: string, isDocsRoot: boolean) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        if (isDocsRoot && SKIPPED_DOCS_SUBDIRS.has(entry)) continue;
        walk(abs, false);
      } else if (stat.isFile() && entry.endsWith(".md")) {
        files.push(abs);
      }
    }
  };
  walk(path.join(repoRoot, "docs"), true);
  return files;
}

export function findBrokenDocLinks(repoRoot: string): string[] {
  const files = collectActiveMarkdownFiles(repoRoot);
  const broken: string[] = [];
  for (const file of files) {
    const targets = extractMarkdownLinkTargets(readFileSync(file, "utf8"));
    for (const rawTarget of targets) {
      const target = rawTarget.split("#")[0]?.split("?")[0] ?? "";
      if (
        target.length === 0 ||
        /^(?:https?:|mailto:|tel:|file:|data:|#)/i.test(rawTarget) ||
        target.includes("{") ||
        target.includes("<")
      ) {
        continue;
      }
      const decodedTarget = decodeLinkPathname(target);
      const resolved = path.resolve(path.dirname(file), decodedTarget);
      if (!existsSync(resolved)) {
        broken.push(`${path.relative(repoRoot, file).replaceAll("\\", "/")} -> ${rawTarget}`);
      }
    }
  }
  return broken;
}

export function findUndocumentedBuiltInDrivers(repoRoot: string): string[] {
  const driversPath = path.join(repoRoot, "apps/server/src/provider/builtInDrivers.ts");
  const prereqsPath = path.join(repoRoot, "docs/provider-prerequisites.md");
  const driversSource = readFileSync(driversPath, "utf8");
  const prereqsSource = readFileSync(prereqsPath, "utf8");

  const arrayMatch = /BUILT_IN_DRIVERS[^=]*=\s*\[([\s\S]*?)\];/m.exec(driversSource);
  if (!arrayMatch?.[1]) {
    return ["Unable to parse BUILT_IN_DRIVERS in builtInDrivers.ts"];
  }
  const drivers = arrayMatch[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const missing: string[] = [];
  for (const driver of drivers) {
    const label = DRIVER_TO_DOC_LABEL[driver];
    if (!label) {
      missing.push(`${driver}: missing DRIVER_TO_DOC_LABEL mapping in scripts/check-docs-links.ts`);
      continue;
    }
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cellPattern = new RegExp(`^\\|\\s*${escapedLabel}\\s*\\|`, "m");
    if (!cellPattern.test(prereqsSource)) {
      missing.push(`${driver} (${label}) missing from docs/provider-prerequisites.md`);
    }
  }
  return missing;
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const brokenLinks = findBrokenDocLinks(repoRoot);
  const missingDrivers = findUndocumentedBuiltInDrivers(repoRoot);
  const failures = [...brokenLinks, ...missingDrivers];
  if (failures.length > 0) {
    console.error("Documentation checks failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("Documentation links and provider parity checks passed.");
}
