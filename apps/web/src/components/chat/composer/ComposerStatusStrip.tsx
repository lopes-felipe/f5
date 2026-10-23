import type { LucideIcon } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import type { StatusChipTone } from "../ThreadNoticeStack";

const CHIP_TONE_CLASS_NAMES: Record<StatusChipTone, string> = {
  neutral: "border-border bg-card text-foreground",
  warning: "border-warning/40 bg-warning/8 text-warning-foreground",
  info: "border-info/40 bg-info/8 text-info-foreground",
};

interface StatusStripHostValue {
  readonly host: HTMLElement | null;
  readonly setHost: (element: HTMLElement | null) => void;
}

const ComposerStatusStripHostContext = createContext<StatusStripHostValue | null>(null);

/**
 * Lets a component outside the strip (the runtime tray, which owns the
 * background-work polling) portal its chip into the strip's slot.
 */
export function ComposerStatusStripHostProvider(props: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ host, setHost }), [host]);
  return (
    <ComposerStatusStripHostContext.Provider value={value}>
      {props.children}
    </ComposerStatusStripHostContext.Provider>
  );
}

/** The strip slot to portal a chip into, or null when no strip is mounted. */
export function useComposerStatusStripHost(): HTMLElement | null {
  return useContext(ComposerStatusStripHostContext)?.host ?? null;
}

/**
 * The compact layout's row of status chips above the composer. It is hidden
 * until a chip is inside, including one portalled into its slot, so it never
 * reserves an empty row.
 */
export function ComposerStatusStrip(props: { children: ReactNode }) {
  return (
    <div
      data-slot="composer-status-strip"
      role="group"
      aria-label="Thread status"
      className="@container/status-strip hidden shrink-0 flex-nowrap items-center gap-2 overflow-x-auto px-3 pt-0.5 pb-1.5 [scrollbar-width:none] has-[[data-status-chip]]:flex [&::-webkit-scrollbar]:hidden"
    >
      {props.children}
    </div>
  );
}

/** Where a portalled chip lands, so it keeps its place in the chip order. */
export function ComposerStatusStripSlot() {
  const setHost = useContext(ComposerStatusStripHostContext)?.setHost;
  return <span ref={setHost} data-slot="composer-status-strip-slot" className="contents" />;
}

export function StatusChip(props: {
  readonly icon?: LucideIcon | undefined;
  readonly label: ReactNode;
  /** Full text of the chip; the label may be shortened. */
  readonly ariaLabel: string;
  readonly tone?: StatusChipTone | undefined;
  /** Accessible name of the popover. */
  readonly popupLabel: string;
  readonly children: ReactNode;
  readonly open?: boolean | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  readonly chipId?: string | undefined;
  /** Where focus lands when the popover opens; defaults to Base UI's choice. */
  readonly initialFocus?: ComponentProps<typeof PopoverPopup>["initialFocus"];
}) {
  const Icon = props.icon;
  return (
    <Popover
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}
    >
      <PopoverTrigger
        data-status-chip={props.chipId ?? ""}
        aria-label={props.ariaLabel}
        title={props.ariaLabel}
        className={cn(
          "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent",
          CHIP_TONE_CLASS_NAMES[props.tone ?? "neutral"],
        )}
      >
        {Icon ? <Icon aria-hidden className="size-3.5 shrink-0" /> : null}
        {props.label}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={6}
        aria-label={props.popupLabel}
        {...(props.initialFocus !== undefined ? { initialFocus: props.initialFocus } : {})}
        // No --available-height in the min(): Base UI sets it to max-content while measuring, which voids the clamp and detaches tall popovers from the chip.
        className="w-[min(28rem,calc(100vw-2rem))] [&>[data-slot=popover-viewport]]:max-h-[min(50dvh,26rem)] [&>[data-slot=popover-viewport]]:p-0"
      >
        {props.children}
      </PopoverPopup>
    </Popover>
  );
}
