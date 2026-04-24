import type { ThreadStatusPill } from "../../threadStatus";

export type ThreadStatusPillVariant = "dot" | "chip";

export function ThreadStatusPillBadge(props: {
  pill: ThreadStatusPill;
  hideLabelBelowMd?: boolean;
  /**
   * `dot` renders the legacy compact variant (colored dot + label). `chip`
   * renders a full pill with an icon, tinted background, and bolder label —
   * used on the Home page where the status deserves pre-attentive weight.
   */
  variant?: ThreadStatusPillVariant;
}) {
  const { pill, hideLabelBelowMd = false, variant = "dot" } = props;
  const Icon = pill.icon;

  if (variant === "chip") {
    return (
      <span
        // role/aria-label keep the status readable to screen readers even when
        // the visual label is hidden on narrow viewports.
        role="status"
        aria-label={pill.label}
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${pill.chipClass}`}
      >
        <Icon className={`size-3 ${pill.pulse ? "animate-pulse" : ""}`} aria-hidden="true" />
        <span className={hideLabelBelowMd ? "hidden md:inline" : undefined}>{pill.label}</span>
      </span>
    );
  }

  return (
    <span
      role="status"
      aria-label={pill.label}
      className={`inline-flex items-center gap-1 text-[10px] ${pill.colorClass}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${pill.dotClass} ${pill.pulse ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      <span className={hideLabelBelowMd ? "hidden md:inline" : undefined}>{pill.label}</span>
    </span>
  );
}
