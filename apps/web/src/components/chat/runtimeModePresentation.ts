import type { RuntimeMode } from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon, type LucideIcon } from "lucide-react";

/**
 * Presentation for runtime (access) modes. The segment colours form a "safe → risky" scale for
 * the Access menu's autonomy ladder; they deliberately avoid the reasoning-effort tokens. Class
 * names are spelled out in full so Tailwind can see them.
 */
export interface RuntimeModePresentation {
  readonly label: string;
  readonly description: string;
  /** Short gloss shown beside the label in the Access menu. */
  readonly tag: string;
  readonly icon: LucideIcon;
  /** Fill for the mode's segment in the Access menu ladder. */
  readonly segmentClass: string;
  /** Glow on the selected mode's segment. */
  readonly glowClass: string;
  /** Text colour for the selected mode's label. */
  readonly textClass: string;
}

export const RUNTIME_MODE_PRESENTATION: Readonly<Record<RuntimeMode, RuntimeModePresentation>> = {
  "approval-required": {
    label: "Supervised",
    description: "Asks before every edit and command.",
    tag: "Asks for all",
    icon: LockIcon,
    segmentClass: "bg-success",
    glowClass: "shadow-[0_0_10px_--theme(--color-success/60%)]",
    textClass: "text-success-foreground",
  },
  "auto-accept-edits": {
    label: "Accept edits",
    description: "Edits apply on their own; asks before commands and other actions.",
    tag: "Asks for commands",
    icon: PenLineIcon,
    segmentClass: "bg-info",
    glowClass: "shadow-[0_0_10px_--theme(--color-info/60%)]",
    textClass: "text-info-foreground",
  },
  auto: {
    label: "Auto",
    description:
      "The provider's AI reviewer approves, not F5. It can allow risky commands without asking.",
    tag: "AI approves",
    icon: SparklesIcon,
    segmentClass: "bg-warning/60",
    glowClass: "shadow-[0_0_10px_--theme(--color-warning/40%)]",
    textClass: "text-warning-foreground",
  },
  "full-access": {
    label: "Full access",
    description: "Edits and commands run without asking.",
    tag: "Never asks",
    icon: LockOpenIcon,
    segmentClass: "bg-warning",
    glowClass: "shadow-[0_0_10px_--theme(--color-warning/60%)]",
    textClass: "text-warning-foreground",
  },
};
