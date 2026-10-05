import type { ThreadStatusPill } from "../../threadStatus";
import { cn } from "../../lib/utils";

export type ThreadStatusPillVariant = "dot" | "chip" | "icon";

export function ThreadStatusPillBadge(props: {
  pill: ThreadStatusPill;
  hideLabelBelowMd?: boolean;
  /**
   * `dot` renders the compact variant (coloured dot + label). `chip` renders a
   * tinted pill with an icon, used where the status deserves pre-attentive
   * weight. `icon` renders only the glyph with an `sr-only` label and a
   * `title`, used in dense lists such as the sidebar.
   */
  variant?: ThreadStatusPillVariant;
  /**
   * Whether the badge is a polite live region. Lists pass `false` so a
   * sidebar full of status changes does not flood screen readers; the thread
   * view owns a single live region for coarse transitions instead.
   */
  live?: boolean;
  className?: string;
}) {
  const { pill, hideLabelBelowMd = false, variant = "dot", live = true, className } = props;
  const Icon = pill.icon;
  const liveProps = live ? { role: "status" as const, "aria-label": pill.label } : {};

  if (variant === "icon") {
    return (
      <span
        className={cn("inline-flex size-4 shrink-0 items-center justify-center", className)}
        title={pill.label}
        {...(live ? { role: "status" as const } : {})}
      >
        <Icon
          aria-hidden="true"
          className={cn("size-3.5", pill.colorClass, pill.pulse && "animate-status-pulse")}
        />
        <span className="sr-only">{pill.label}</span>
      </span>
    );
  }

  if (variant === "chip") {
    return (
      <span
        {...liveProps}
        className={cn(
          "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-2xs font-medium",
          pill.chipClass,
          className,
        )}
      >
        <Icon className={cn("size-3", pill.pulse && "animate-status-pulse")} aria-hidden="true" />
        <span className={hideLabelBelowMd ? "hidden md:inline" : undefined}>{pill.label}</span>
      </span>
    );
  }

  return (
    <span
      {...liveProps}
      className={cn("inline-flex items-center gap-1 text-2xs", pill.colorClass, className)}
    >
      <span
        className={cn("size-1.5 rounded-full", pill.dotClass, pill.pulse && "animate-status-pulse")}
        aria-hidden="true"
      />
      <span className={hideLabelBelowMd ? "hidden md:inline" : undefined}>{pill.label}</span>
    </span>
  );
}
