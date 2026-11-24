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

const DOCS_SUBDIRS = ["docs", "docs/user", "docs/providers", "docs/design"] as const;

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

function stripCodeFences(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, "");
}

export function findBrokenDocLinks(repoRoot: string): string[] {
  const files: string[] = [];
  for (const rel of ROOT_DOCS) {
    const abs = path.join(repoRoot, rel);
    if (existsSync(abs)) files.push(abs);
  }
  for (const subdir of DOCS_SUBDIRS) {
    const dir = path.join(repoRoot, subdir);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const abs = path.join(dir, entry);
      if (statSync(abs).isFile()) files.push(abs);
    }
  }

  const broken: string[] = [];
  for (const file of files) {
    const source = stripCodeFences(readFileSync(file, "utf8"));
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const rawTarget = match[1] ?? "";
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
    const label = DRIVER_TO_DOC_LABEL[driver];
    if (!label) {
      missing.push(`${driver}: missing DRIVER_TO_DOC_LABEL mapping in scripts/check-docs-links.ts`);
      continue;
    }
    if (!prereqsSource.includes(`| ${label}`)) {
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
