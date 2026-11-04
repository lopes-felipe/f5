"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { Separator } from "./separator";

/**
 * `track` (default) is the segmented shell used by the header's side-panel
 * toggle: a quiet rounded track holding 24px segments, no dividers. Use
 * ghost buttons inside it (`icon-xs` for icon-only segments). `joined` butts
 * solid buttons edge to edge, for split primary actions.
 */
const groupVariants = cva("flex w-fit *:focus-visible:z-1 *:has-focus-visible:z-1", {
  compoundVariants: [
    {
      className:
        "*:data-slot:has-[~[data-slot]]:rounded-e-none *:data-slot:has-[~[data-slot]]:border-e-0 *:[[data-slot]~[data-slot]]:rounded-s-none *:[[data-slot]~[data-slot]]:border-s-0",
      orientation: "horizontal",
      variant: "joined",
    },
    {
      className:
        "flex-col *:data-slot:has-[~[data-slot]]:rounded-b-none *:data-slot:has-[~[data-slot]]:border-b-0 *:[[data-slot]~[data-slot]]:rounded-t-none *:[[data-slot]~[data-slot]]:border-t-0",
      orientation: "vertical",
      variant: "joined",
    },
    {
      className: "flex-col",
      orientation: "vertical",
      variant: "track",
    },
  ],
  defaultVariants: {
    orientation: "horizontal",
    variant: "track",
  },
  variants: {
    orientation: {
      horizontal: "",
      vertical: "",
    },
    variant: {
      joined:
        "has-[>[data-slot=group]]:gap-2 *:pointer-coarse:after:min-w-auto *:pointer-coarse:after:min-h-auto",
      track:
        // Segments are matched as any direct child: triggers (menu, popover)
        // rendering a Button replace its `data-slot`.
        "items-center gap-px rounded-lg border border-border/70 bg-muted/40 p-0.5 [&>:not([data-slot=separator])]:h-6 [&>:not([data-slot=separator])]:rounded-md [&>:not([data-slot=separator])]:border-transparent [&>:not([data-slot=separator])]:bg-transparent [&>:not([data-slot=separator])]:shadow-none [&>:not([data-slot=separator]):hover]:bg-accent [&>[data-pressed]]:bg-accent [&>[data-popup-open]]:bg-accent [&>[data-slot=separator]]:hidden",
    },
  },
});

function Group({
  className,
  orientation,
  variant,
  children,
  ...props
}: {
  className?: string;
  orientation?: VariantProps<typeof groupVariants>["orientation"];
  variant?: VariantProps<typeof groupVariants>["variant"];
  children: React.ReactNode;
} & React.ComponentProps<"div">) {
  return (
    <div
      className={cn(groupVariants({ orientation, variant }), className)}
      data-orientation={orientation}
      data-slot="group"
      data-variant={variant ?? "track"}
      role="group"
      {...props}
    >
      {children}
    </div>
  );
}

function GroupText({ className, render, ...props }: useRender.ComponentProps<"div">) {
  const defaultProps = {
    className: cn(
      "relative inline-flex items-center whitespace-nowrap gap-2 rounded-md bg-secondary px-[calc(--spacing(3)-1px)] text-muted-foreground text-base sm:text-sm outline-none [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:-mx-0.5",
      className,
    ),
    "data-slot": "group-text",
  };
  return useRender({
    defaultTagName: "div",
    props: mergeProps(defaultProps, props),
    render,
  });
}

function GroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: {
  className?: string;
} & React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "pointer-events-none relative z-2 bg-border has-[+[data-slot=input-control]:focus-within,+[data-slot=input-group]:focus-within,+[data-slot=select-trigger]:focus-visible+*,+[data-slot=number-field]:focus-within]:bg-ring [[data-slot=input-control]:focus-within+&,[data-slot=input-group]:focus-within+&,[data-slot=select-trigger]:focus-visible+*+&,[data-slot=number-field]:focus-within+&,[data-slot=number-field]:focus-within+input+&]:bg-ring",
        className,
      )}
      orientation={orientation}
      {...props}
    />
  );
}

export {
  Group,
  Group as ButtonGroup,
  GroupText,
  GroupText as ButtonGroupText,
  GroupSeparator,
  GroupSeparator as ButtonGroupSeparator,
  groupVariants,
};
