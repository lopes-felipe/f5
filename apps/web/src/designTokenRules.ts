/**
 * Banned styling patterns (see `designTokens.test.ts` and
 * `docs/design/direction.md`). Every scanned file must be clean. Shared with
 * `scripts/codemod-ui-tokens.ts` so both agree on what counts.
 */

const PALETTE_NAMES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
].join("|");

const PALETTE_UTILITIES = [
  "bg",
  "text",
  "border(?:-[trblxyse])?",
  "ring",
  "ring-offset",
  "outline",
  "divide",
  "from",
  "via",
  "to",
  "fill",
  "stroke",
  "shadow",
  "decoration",
  "accent",
  "caret",
  "placeholder",
].join("|");

export const DESIGN_TOKEN_RULES = {
  /** Raw Tailwind palette colours (`text-emerald-600`); use semantic tokens. */
  palette: new RegExp(`\\b(?:${PALETTE_UTILITIES})-(?:${PALETTE_NAMES})-\\d{2,3}\\b`, "g"),
  /** Arbitrary text sizes (`text-[11px]`); use `text-2xs`/`text-xs`/`text-ui`/`text-sm`. */
  arbitraryText: /\btext-\[(?:\d+px|\.?\d*\.?\d+rem)\]/g,
  /** Faded foreground text (`text-muted-foreground/70`); use `text-faint-foreground`. */
  fadedText: /\btext-(?:muted-)?foreground\/(?!0\b)\d+/g,
  /** Pixel radii (`rounded-[10px]`); use the radius scale. */
  pxRadius: /\brounded(?:-\w+)?-\[\d+px\]/g,
} as const;

export type DesignTokenRuleName = keyof typeof DESIGN_TOKEN_RULES;

export const DESIGN_TOKEN_RULE_NAMES = Object.keys(DESIGN_TOKEN_RULES) as DesignTokenRuleName[];

export type DesignTokenCounts = Partial<Record<DesignTokenRuleName, number>>;

/**
 * Files that legitimately own raw colour values (theme engine, project colour
 * swatches) or define the rules themselves. Paths are relative to `src/`.
 */
export const DESIGN_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set([
  "designTokenRules.ts",
  "index.css",
  "themePalette.ts",
  "lib/projectColor.ts",
  "components/ProjectIcon.tsx",
]);

/** Test files assert on class strings and are not scanned. */
export function isDesignTokenScannedPath(relativePath: string): boolean {
  if (DESIGN_TOKEN_ALLOWLIST.has(relativePath)) return false;
  if (/\.(?:test|browser)\.tsx?$/.test(relativePath)) return false;
  return /\.(?:tsx?|css)$/.test(relativePath);
}

export function countDesignTokenViolations(source: string): DesignTokenCounts {
  const counts: DesignTokenCounts = {};
  for (const name of DESIGN_TOKEN_RULE_NAMES) {
    const matches = source.match(DESIGN_TOKEN_RULES[name]);
    if (matches && matches.length > 0) counts[name] = matches.length;
  }
  return counts;
}
