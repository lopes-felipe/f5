#!/usr/bin/env bun
/**
 * Rewrites banned styling patterns (see `src/designTokenRules.ts`) to the F1
 * type scale and F2 semantic colour tokens. Idempotent: a second run is a
 * no-op. Dry-run by default; prints a per-file report and every match it could
 * not map, which needs a human decision.
 *
 *   bun apps/web/scripts/codemod-ui-tokens.ts [--write] [src-relative paths...]
 *
 * With no paths, every scanned file under `apps/web/src` is processed.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { countDesignTokenViolations, isDesignTokenScannedPath } from "../src/designTokenRules";

const srcDir = join(import.meta.dir, "..", "src");
const write = process.argv.includes("--write");
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

// F1: arbitrary sizes onto the type scale.
const TEXT_SIZE_MAP: Record<string, string> = {
  "9px": "text-2xs",
  "10px": "text-2xs",
  "10.5px": "text-2xs",
  "11px": "text-2xs",
  "11.5px": "text-xs",
  "12px": "text-xs",
  "12.5px": "text-ui",
  "13px": "text-ui",
  "13.5px": "text-sm",
  "14px": "text-sm",
  "0.625rem": "text-2xs",
  "0.6875rem": "text-2xs",
  ".6875rem": "text-2xs",
  "0.7rem": "text-2xs",
  ".7rem": "text-2xs",
  "0.75rem": "text-xs",
  ".75rem": "text-xs",
  "0.8rem": "text-ui",
  ".8rem": "text-ui",
  "0.8125rem": "text-ui",
  ".8125rem": "text-ui",
  "0.875rem": "text-sm",
  ".875rem": "text-sm",
};

// F2: palette families onto semantic tones. Unlisted families are reported.
const TONE_MAP: Record<string, string> = {
  emerald: "success",
  green: "success",
  amber: "warning",
  yellow: "warning",
  orange: "warning",
  sky: "info",
  blue: "info",
  cyan: "info",
  red: "destructive",
  rose: "destructive",
  violet: "attention",
  indigo: "attention",
  purple: "attention",
};

const NEUTRAL_FAMILIES = new Set(["slate", "gray", "zinc", "neutral", "stone"]);

const VARIANTS = String.raw`((?:[\w\-\[\]&:*>.()=@/]+:)*)`;

const TEXT_SIZE_RE = new RegExp(String.raw`(?<![\w-])${VARIANTS}text-\[([\d.]+(?:px|rem))\]`, "g");
const FADED_RE = new RegExp(
  String.raw`(?<![\w-])${VARIANTS}text-(muted-foreground|foreground)\/(\d+)(?![\w\d])`,
  "g",
);
const PALETTE_RE = new RegExp(
  String.raw`(?<![\w-])${VARIANTS}(bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|divide|from|via|to|fill|stroke|shadow|decoration|accent|caret|placeholder)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(\d{2,3})(?:\/(\d+|\[[^\]]+\]))?(?![\w-])`,
  "g",
);
const PX_RADIUS_RE = new RegExp(
  String.raw`(?<![\w-])${VARIANTS}rounded(-[a-z]+)?-\[(\d+)px\]`,
  "g",
);

/**
 * Maps a pixel radius onto the `--radius: 0.75rem` scale from `index.css`
 * (sm 8, md 10, lg 12, xl 16, 2xl 20, 3xl 24, 4xl 28; bare `rounded` is 4px).
 */
function radiusFor(px: number): string | null {
  if (px <= 3) return "-xs";
  if (px <= 5) return "";
  if (px <= 8) return "-sm";
  if (px <= 10) return "-md";
  if (px <= 13) return "-lg";
  if (px <= 17) return "-xl";
  if (px <= 21) return "-2xl";
  if (px <= 25) return "-3xl";
  if (px <= 29) return "-4xl";
  if (px >= 999) return "-full";
  return null;
}

/**
 * F2: text uses `foreground` or `muted-foreground` only. Faded icons and
 * separators should become `text-faint-foreground`; the codemod cannot tell
 * them apart from text, so it reports likely icons for a manual decision.
 */
function fadedReplacement(base: string, alpha: number): string {
  if (base === "foreground" && alpha >= 70) return "text-foreground";
  return "text-muted-foreground";
}

function trackingReplacement(value: string): string | null {
  const match = /^(-?[\d.]+)em$/.exec(value);
  if (!match) return null;
  const em = Number(match[1]);
  if (em < 0) return "tracking-tight";
  if (em <= 0.02) return "tracking-normal";
  if (em <= 0.05) return "tracking-wide";
  return "tracking-wider";
}

const TRACKING_RE = new RegExp(String.raw`(?<![\w-])${VARIANTS}tracking-\[([^\]]+)\]`, "g");
const FIXED_BOX_RE = /(?:^|\s)(?:size|h|min-w|min-h)-(?:3|3\.5|4|4\.5)(?:\s|$)/;
const ICON_HINT_RE = /(?:^|\s)size-(?:3|3\.5|4|4\.5|5)(?:\s|$)|Icon\b/;

function paletteReplacement(
  utility: string,
  family: string,
  shade: number,
  alpha: string | undefined,
): string | null {
  const suffix = alpha ? `/${alpha}` : "";
  if (NEUTRAL_FAMILIES.has(family)) {
    if (utility === "text" || utility === "fill" || utility === "stroke") {
      if (shade >= 700) return `${utility}-foreground`;
      return `${utility}-muted-foreground`;
    }
    if (utility === "bg") return shade >= 700 ? `bg-foreground${suffix}` : `bg-muted${suffix}`;
    if (utility.startsWith("border") || utility === "divide") return `${utility}-border${suffix}`;
    return null;
  }
  const tone = TONE_MAP[family];
  if (!tone) return null;
  if (utility === "text" || utility === "fill" || utility === "stroke") {
    return `${utility}-${tone}-foreground${suffix}`;
  }
  if (utility === "bg") {
    if (alpha) return `bg-${tone}${suffix}`;
    if (shade <= 100) return `bg-${tone}/10`;
    if (shade <= 200) return `bg-${tone}/20`;
    return `bg-${tone}`;
  }
  if (utility.startsWith("border") || utility === "ring" || utility === "outline") {
    if (alpha) return `${utility}-${tone}${suffix}`;
    return shade <= 300 ? `${utility}-${tone}/40` : `${utility}-${tone}`;
  }
  if (
    utility === "from" ||
    utility === "via" ||
    utility === "to" ||
    utility === "accent" ||
    utility === "shadow"
  ) {
    return `${utility}-${tone}${suffix}`;
  }
  return null;
}

/**
 * Per class list: drops exact duplicates and `dark:X` twins of `X`, fixes
 * hover pairs that collapsed onto the same token (`text-muted-foreground
 * hover:text-muted-foreground` becomes `hover:text-foreground`), and notes
 * likely faded icons, size bumps inside fixed boxes, and uppercase labels.
 */
function postProcessClassLists(
  source: string,
  touched: Set<string>,
  fadedTouched: Set<string>,
  notes: string[],
): string {
  return source.replace(/(["`])([^"`\n]*)\1/g, (literal, quote: string, body: string) => {
    const tokens = body.split(/\s+/).filter(Boolean);
    const hasTouched = tokens.some((token) => touched.has(token));
    if (!hasTouched) return literal;
    const excerpt = body.trim().slice(0, 90);

    if (tokens.some((token) => fadedTouched.has(token)) && ICON_HINT_RE.test(body)) {
      notes.push(`faded icon? consider text-faint-foreground: "${excerpt}"`);
    }
    if (tokens.some((token) => token.endsWith("text-2xs") && touched.has(token))) {
      if (FIXED_BOX_RE.test(` ${body} `)) {
        notes.push(`size bumped inside a fixed box; check h-4.5/min-w-4.5: "${excerpt}"`);
      }
    }
    if (tokens.includes("uppercase")) {
      notes.push(`uppercase label; consider SectionLabel (sentence case): "${excerpt}"`);
    }
    if (body.includes("${")) return literal;

    const seen = new Set<string>();
    const kept: string[] = [];
    for (const token of tokens) {
      if (seen.has(token)) continue;
      if (token.startsWith("dark:") && tokens.includes(token.slice(5)) && touched.has(token)) {
        continue;
      }
      seen.add(token);
      kept.push(token);
    }
    for (let index = 0; index < kept.length; index += 1) {
      const token = kept[index]!;
      const match =
        /^((?:[\w-]+:)*)(hover|group-hover\/?[\w-]*|focus-visible):text-muted-foreground$/.exec(
          token,
        );
      if (!match) continue;
      const base = `${match[1]}text-muted-foreground`;
      if (kept.includes(base) && touched.has(base)) {
        kept[index] = `${match[1]}${match[2]}:text-foreground`;
        notes.push(`collapsed hover pair -> ${kept[index]}: "${excerpt}"`);
      }
    }
    const rebuilt = kept.join(" ");
    if (rebuilt === tokens.join(" ")) return literal;
    const leading = /^\s/.test(body) ? " " : "";
    const trailing = /\s$/.test(body) ? " " : "";
    return `${quote}${leading}${rebuilt}${trailing}${quote}`;
  });
}

interface FileReport {
  path: string;
  replaced: number;
  unmapped: string[];
  notes: string[];
}

function transform(path: string, source: string): { output: string; report: FileReport } {
  const report: FileReport = { path, replaced: 0, unmapped: [], notes: [] };
  const touched = new Set<string>();
  const fadedTouched = new Set<string>();
  const record = (variants: string, replacement: string) => {
    report.replaced += 1;
    touched.add(`${variants}${replacement}`);
    return `${variants}${replacement}`;
  };

  let output = source.replace(TEXT_SIZE_RE, (match, variants: string, size: string) => {
    const mapped = TEXT_SIZE_MAP[size];
    if (!mapped) {
      report.unmapped.push(match);
      return match;
    }
    return record(variants, mapped);
  });

  output = output.replace(FADED_RE, (match, variants: string, base: string, alpha: string) => {
    const value = Number(alpha);
    if (value === 0) return match;
    const replacement = record(variants, fadedReplacement(base, value));
    fadedTouched.add(replacement);
    return replacement;
  });

  output = output.replace(TRACKING_RE, (match, variants: string, value: string) => {
    const mapped = trackingReplacement(value);
    if (!mapped) {
      report.unmapped.push(match);
      return match;
    }
    return record(variants, mapped);
  });

  output = output.replace(
    PALETTE_RE,
    (match, variants: string, utility: string, family: string, shade: string, alpha?: string) => {
      const mapped = paletteReplacement(utility, family, Number(shade), alpha);
      if (!mapped) {
        report.unmapped.push(match);
        return match;
      }
      return record(variants, mapped);
    },
  );

  output = output.replace(PX_RADIUS_RE, (match, variants: string, side = "", px: string) => {
    const size = radiusFor(Number(px));
    if (size === null) {
      report.unmapped.push(match);
      return match;
    }
    return record(variants, `rounded${side}${size}`);
  });

  if (touched.size === 0) return { output, report };
  return { output: postProcessClassLists(output, touched, fadedTouched, report.notes), report };
}

function listFiles(): string[] {
  if (requested.length > 0) {
    return requested.map((path) => path.replace(/^(?:\.\/)?(?:apps\/web\/)?(?:src\/)?/, ""));
  }
  const files: string[] = [];
  for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relativePath = relative(srcDir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (isDesignTokenScannedPath(relativePath)) files.push(relativePath);
  }
  return files.toSorted();
}

let totalReplaced = 0;
let totalUnmapped = 0;
for (const path of listFiles()) {
  const absolute = join(srcDir, path);
  const source = readFileSync(absolute, "utf8");
  if (Object.keys(countDesignTokenViolations(source)).length === 0 && !TRACKING_RE.test(source)) {
    continue;
  }
  TRACKING_RE.lastIndex = 0;
  const { output, report } = transform(path, source);
  totalReplaced += report.replaced;
  totalUnmapped += report.unmapped.length;
  if (report.replaced === 0 && report.unmapped.length === 0) continue;
  console.log(`${path}: ${report.replaced} replaced, ${report.unmapped.length} unmapped`);
  for (const match of new Set(report.unmapped)) console.log(`    unmapped: ${match}`);
  for (const note of new Set(report.notes)) console.log(`    note: ${note}`);
  if (write && output !== source) writeFileSync(absolute, output);
}

console.log(
  `\n${write ? "Rewrote" : "Would rewrite"} ${totalReplaced} classes; ${totalUnmapped} need a manual decision.`,
);
if (!write) console.log("Dry run. Pass --write to apply.");
