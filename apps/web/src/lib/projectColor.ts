/**
 * A palette of calming-but-distinct colors for project indicators. The dot is
 * rendered next to the project name on the Home page to give users an instant,
 * pre-attentive way to group threads by project without having to read text.
 *
 * Colors are expressed as Tailwind utility class combinations (background +
 * ring) so they can be applied directly to a `<span />`. Keep the palette to a
 * short, memorable set: too many near-identical hues defeats the purpose.
 */
const PROJECT_COLOR_PALETTE: ReadonlyArray<{
  readonly bg: string;
  readonly ring: string;
}> = [
  { bg: "bg-sky-500", ring: "ring-sky-500/30" },
  { bg: "bg-violet-500", ring: "ring-violet-500/30" },
  { bg: "bg-emerald-500", ring: "ring-emerald-500/30" },
  { bg: "bg-amber-500", ring: "ring-amber-500/30" },
  { bg: "bg-rose-500", ring: "ring-rose-500/30" },
  { bg: "bg-indigo-500", ring: "ring-indigo-500/30" },
  { bg: "bg-teal-500", ring: "ring-teal-500/30" },
  { bg: "bg-orange-500", ring: "ring-orange-500/30" },
  { bg: "bg-cyan-500", ring: "ring-cyan-500/30" },
  { bg: "bg-pink-500", ring: "ring-pink-500/30" },
];

/**
 * Deterministic FNV-1a-ish hash. We use a stable hash over the project id (or
 * falls back to name) so the color stays the same across sessions and
 * reloads. Avoids the `String.prototype` hash-via-charCode loop pattern so the
 * output is not sensitive to string length in the typical way.
 */
function stableHashString(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiplication in 32-bit integer space.
    hash = Math.imul(hash, 0x01000193);
  }
  // Ensure unsigned.
  return hash >>> 0;
}

export interface ProjectColorClasses {
  readonly bg: string;
  readonly ring: string;
}

export function getProjectColorClasses(key: string): ProjectColorClasses {
  if (!key) {
    // Use a neutral but visible default rather than throwing; Home rows always
    // render a dot even for threads with an unresolved project.
    return { bg: "bg-muted-foreground/50", ring: "ring-muted-foreground/20" };
  }
  const index = stableHashString(key) % PROJECT_COLOR_PALETTE.length;
  return PROJECT_COLOR_PALETTE[index]!;
}
