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

const DRIVER_TO_DOC_LABEL: Readonly<
  Record<string, { readonly label: string; readonly guide: string }>
> = {
  CodexDriver: { label: "Codex", guide: "docs/providers/codex.md" },
  ClaudeDriver: { label: "Claude Code", guide: "docs/providers/claude.md" },
  CursorDriver: { label: "Cursor", guide: "docs/providers/cursor.md" },
  OpenCodeDriver: { label: "OpenCode", guide: "docs/providers/opencode.md" },
  GrokDriver: { label: "Grok", guide: "docs/providers/grok.md" },
  AntigravityDriver: { label: "Antigravity", guide: "docs/providers/antigravity.md" },
  MuseDriver: { label: "Muse Code", guide: "docs/providers/muse.md" },
  PiDriver: { label: "Pi", guide: "docs/providers/pi.md" },
  AcpDriver: { label: "Custom ACP", guide: "docs/providers/acp.md" },
};

/**
 * Strips fenced code blocks (CommonMark rules: closing fence must use the same
 * character, at least the opener's length, and only trailing whitespace) and
 * inline code spans so example links inside code are ignored.
 */
export function stripCodeBlocksAndInlineCode(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let activeFence: { readonly char: string; readonly length: number } | null = null;

  for (const line of lines) {
    if (activeFence === null) {
      const openMatch = /^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
      if (openMatch?.[1]) {
        const marker = openMatch[1];
        const char = marker[0]!;
        // CommonMark: backtick info strings cannot contain backticks.
        if (char !== "`" || !line.slice(openMatch[0].length).includes("`")) {
          activeFence = { char, length: marker.length };
          continue;
        }
      }
      // Strip inline code spans (`...`) on non-fenced lines.
      kept.push(line.replace(/(`+)([^`]|(?!(?<!`)\1(?!`))`)*?\1/g, ""));
    } else {
      const closePattern = new RegExp(
        `^[ ]{0,3}${activeFence.char}{${activeFence.length},}[ \\t]*$`,
      );
      if (closePattern.test(line)) {
        activeFence = null;
      }
    }
  }

  return kept.join("\n");
}

/**
 * Extracts markdown link targets while supporting one level of balanced
 * parentheses (e.g. `foo(bar).md`).
 */
export function extractMarkdownLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const cleaned = stripCodeBlocksAndInlineCode(markdown);
  const pattern = /!?\[[^\]]*\]\(((?:[^()\s]+|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g;
  for (const match of cleaned.matchAll(pattern)) {
    const rawTarget = match[1];
    if (rawTarget) targets.push(rawTarget);
  }
  return targets;
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
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) {
        broken.push(`${path.relative(repoRoot, file)} -> ${rawTarget}`);
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
    const info = DRIVER_TO_DOC_LABEL[driver];
    if (!info) {
      missing.push(`${driver}: missing DRIVER_TO_DOC_LABEL mapping in scripts/check-docs-links.ts`);
      continue;
    }
    const escapedLabel = info.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const cellPattern = new RegExp(`^\\|\\s*${escapedLabel}\\s*\\|`, "m");
    if (!cellPattern.test(prereqsSource)) {
      missing.push(`${driver} (${info.label}) missing from docs/provider-prerequisites.md`);
    }
    if (!existsSync(path.join(repoRoot, info.guide))) {
      missing.push(`${driver} (${info.label}) missing provider guide ${info.guide}`);
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
