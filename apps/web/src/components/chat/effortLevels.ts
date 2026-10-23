import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

/**
 * Presentation for reasoning-effort levels: a fixed colour per level id (cool
 * for fast, warm for deep) so the same level reads the same across providers
 * and models. Colours come from the `effort-*` tokens in `index.css`; class
 * names are spelled out in full so Tailwind can see them.
 */
export interface EffortLevelPresentation {
  /** Higher ranks think longer. Only the relative order matters. */
  readonly rank: number;
  readonly tag: string;
  /** Fill for the level's segment in the effort menu. */
  readonly segmentClass: string;
  /** Glow on the selected level's segment. */
  readonly glowClass: string;
  /** Text colour for the selected level's label. */
  readonly textClass: string;
  /** Tint for the composer trigger chip; overrides the chip's neutral states. */
  readonly chipClass: string;
}

const EFFORT_LEVELS: Readonly<Record<string, EffortLevelPresentation>> = {
  low: {
    rank: 0,
    tag: "Fastest",
    segmentClass: "bg-effort-low",
    glowClass: "shadow-[0_0_10px_--theme(--color-effort-low/60%)]",
    textClass: "text-effort-low-foreground",
    chipClass:
      "border-effort-low/25 bg-effort-low/10 text-effort-low-foreground hover:bg-effort-low/15 hover:text-effort-low-foreground data-popup-open:bg-effort-low/15 data-popup-open:text-effort-low-foreground [:hover,[data-pressed]]:bg-effort-low/15 data-pressed:bg-effort-low/15 data-pressed:text-effort-low-foreground",
  },
  medium: {
    rank: 1,
    tag: "Balanced",
    segmentClass: "bg-effort-medium",
    glowClass: "shadow-[0_0_10px_--theme(--color-effort-medium/60%)]",
    textClass: "text-effort-medium-foreground",
    chipClass:
      "border-effort-medium/25 bg-effort-medium/10 text-effort-medium-foreground hover:bg-effort-medium/15 hover:text-effort-medium-foreground data-popup-open:bg-effort-medium/15 data-popup-open:text-effort-medium-foreground [:hover,[data-pressed]]:bg-effort-medium/15 data-pressed:bg-effort-medium/15 data-pressed:text-effort-medium-foreground",
  },
  high: {
    rank: 2,
    tag: "Thorough",
    segmentClass: "bg-effort-high",
    glowClass: "shadow-[0_0_10px_--theme(--color-effort-high/60%)]",
    textClass: "text-effort-high-foreground",
    chipClass:
      "border-effort-high/25 bg-effort-high/10 text-effort-high-foreground hover:bg-effort-high/15 hover:text-effort-high-foreground data-popup-open:bg-effort-high/15 data-popup-open:text-effort-high-foreground [:hover,[data-pressed]]:bg-effort-high/15 data-pressed:bg-effort-high/15 data-pressed:text-effort-high-foreground",
  },
  xhigh: {
    rank: 3,
    tag: "Deep",
    segmentClass: "bg-effort-xhigh",
    glowClass: "shadow-[0_0_10px_--theme(--color-effort-xhigh/60%)]",
    textClass: "text-effort-xhigh-foreground",
    chipClass:
      "border-effort-xhigh/25 bg-effort-xhigh/10 text-effort-xhigh-foreground hover:bg-effort-xhigh/15 hover:text-effort-xhigh-foreground data-popup-open:bg-effort-xhigh/15 data-popup-open:text-effort-xhigh-foreground [:hover,[data-pressed]]:bg-effort-xhigh/15 data-pressed:bg-effort-xhigh/15 data-pressed:text-effort-xhigh-foreground",
  },
  max: {
    rank: 4,
    tag: "Deeper",
    segmentClass: "bg-effort-max",
    glowClass: "shadow-[0_0_10px_--theme(--color-effort-max/60%)]",
    textClass: "text-effort-max-foreground",
    chipClass:
      "border-effort-max/25 bg-effort-max/10 text-effort-max-foreground hover:bg-effort-max/15 hover:text-effort-max-foreground data-popup-open:bg-effort-max/15 data-popup-open:text-effort-max-foreground [:hover,[data-pressed]]:bg-effort-max/15 data-pressed:bg-effort-max/15 data-pressed:text-effort-max-foreground",
  },
};

const DEEPEST: Omit<EffortLevelPresentation, "rank"> = {
  tag: "Deepest",
  segmentClass: "bg-effort-deepest",
  glowClass: "shadow-[0_0_10px_--theme(--color-effort-deepest/60%)]",
  textClass: "text-effort-deepest-foreground",
  chipClass:
    "border-effort-deepest/25 bg-effort-deepest/10 text-effort-deepest-foreground hover:bg-effort-deepest/15 hover:text-effort-deepest-foreground data-popup-open:bg-effort-deepest/15 data-popup-open:text-effort-deepest-foreground [:hover,[data-pressed]]:bg-effort-deepest/15 data-pressed:bg-effort-deepest/15 data-pressed:text-effort-deepest-foreground",
};

const ALL_EFFORT_LEVELS: Readonly<Record<string, EffortLevelPresentation>> = {
  ...EFFORT_LEVELS,
  // Codex's top tier and Claude's prompt-injected keyword share the warmest colour.
  ultra: { rank: 5, ...DEEPEST },
  ultrathink: { rank: 6, ...DEEPEST },
};

/** Option ids that carry the effort scale, across provider descriptors. */
const EFFORT_DESCRIPTOR_IDS = new Set([
  "effort",
  "reasoningEffort",
  "reasoning",
  "variant",
  "thinking",
]);

export function getEffortLevel(id: string | null | undefined): EffortLevelPresentation | null {
  if (!id || !Object.hasOwn(ALL_EFFORT_LEVELS, id)) {
    return null;
  }
  return ALL_EFFORT_LEVELS[id] ?? null;
}

/** True when every option is a known effort level, so the scale can be ranked and coloured. */
export function isEffortScale(options: ReadonlyArray<{ readonly id: string }>): boolean {
  return options.length > 0 && options.every((option) => getEffortLevel(option.id) !== null);
}

/** Highest effort first. Unknown ids sort last, keeping their relative order. */
export function sortEffortOptions<T extends { readonly id: string }>(
  options: ReadonlyArray<T>,
): T[] {
  return options.toSorted(
    (left, right) => (getEffortLevel(right.id)?.rank ?? -1) - (getEffortLevel(left.id)?.rank ?? -1),
  );
}

/**
 * Whether a descriptor is a reasoning-effort select whose levels are all known.
 * Deliberately not a type guard: a select that fails the check is still a select.
 */
export function isEffortDescriptor(descriptor: ProviderOptionDescriptor): boolean {
  return (
    descriptor.type === "select" &&
    EFFORT_DESCRIPTOR_IDS.has(descriptor.id) &&
    isEffortScale(descriptor.options)
  );
}

/** Chip tint for the effort selected in a descriptor list, or null when none applies. */
export function getEffortChipClass(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): { level: string; className: string } | null {
  const effortDescriptor = descriptors.find(isEffortDescriptor);
  if (!effortDescriptor) {
    return null;
  }
  const level = getProviderOptionCurrentValue(effortDescriptor);
  const presentation = typeof level === "string" ? getEffortLevel(level) : null;
  return typeof level === "string" && presentation
    ? { level, className: presentation.chipClass }
    : null;
}

/** Step only the reasoning select, retaining defaults and all unrelated model traits. */
export function stepEffortOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  direction: 1 | -1,
) {
  const descriptor = descriptors.find(
    (entry): entry is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      entry.type === "select" && EFFORT_DESCRIPTOR_IDS.has(entry.id),
  );
  if (!descriptor || descriptor.options.length < 2) return null;
  const options = isEffortScale(descriptor.options)
    ? sortEffortOptions(descriptor.options).toReversed()
    : descriptor.options;
  const current = getProviderOptionCurrentValue(descriptor);
  let position = options.findIndex((option) => option.id === current);
  if (position < 0) position = options.findIndex((option) => option.isDefault);
  if (position < 0) position = direction > 0 ? -1 : 0;
  const next = options[(position + direction + options.length) % options.length]!;
  return (
    buildProviderOptionSelectionsFromDescriptors(
      descriptors.map((entry) =>
        entry.id === descriptor.id ? { ...descriptor, currentValue: next.id } : entry,
      ),
    ) ?? null
  );
}
