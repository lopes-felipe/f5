import { cn } from "../../lib/utils";

export type HomeStripChipTone = "default" | "warning" | "error";

const DOT_CLASS_BY_TONE: Record<HomeStripChipTone, string | null> = {
  default: null,
  warning: "bg-warning",
  error: "bg-destructive",
};

/** One chip of Home's status strip: a count or state of another surface, linking to it. */
export function HomeStripChip(props: {
  readonly tone?: HomeStripChipTone | undefined;
  readonly title?: string | undefined;
  readonly testId?: string | undefined;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  const dotClass = DOT_CLASS_BY_TONE[props.tone ?? "default"];
  return (
    <button
      type="button"
      title={props.title}
      data-testid={props.testId}
      onClick={props.onClick}
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border px-2.5 text-ui text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        props.tone === "error" && "border-destructive/40",
        props.tone === "warning" && "border-warning/40",
      )}
    >
      {dotClass ? (
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
      ) : null}
      <span className="min-w-0 truncate">{props.children}</span>
    </button>
  );
}

/** The emphasised part of a chip: its number or time. */
export function HomeStripValue(props: { readonly children: React.ReactNode }) {
  return <span className="font-medium text-foreground tabular-nums">{props.children}</span>;
}
