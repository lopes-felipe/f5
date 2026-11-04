"use client";

import type { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "~/lib/utils";
import { Separator } from "~/components/ui/separator";
import { Toggle as ToggleComponent, type toggleVariants } from "~/components/ui/toggle";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

function ToggleGroup({
  className,
  variant = "default",
  size = "default",
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props & VariantProps<typeof toggleVariants>) {
  const value = React.useMemo(() => ({ size, variant }), [size, variant]);
  return (
    <ToggleGroupPrimitive
      className={cn(
        "flex w-fit *:focus-visible:z-10",
        orientation === "horizontal"
          ? "*:pointer-coarse:after:min-w-auto"
          : "*:pointer-coarse:after:min-h-auto flex-col",
        // `outline` is the segmented track shared with the header's side-panel
        // toggle and `Group`: a quiet shell with transparent segments.
        variant === "default"
          ? "gap-0.5"
          : "gap-px rounded-lg border border-border/70 bg-muted/40 p-0.5 [&>[data-slot=toggle]]:border-transparent [&>[data-slot=toggle]]:bg-transparent [&>[data-slot=toggle]]:text-muted-foreground [&>[data-slot=toggle]:hover]:bg-accent [&>[data-slot=toggle]:hover]:text-foreground [&>[data-slot=toggle][data-pressed]]:bg-accent [&>[data-slot=toggle][data-pressed]]:text-foreground [&>[data-slot=toggle][data-pressed]]:shadow-xs [&>[data-slot=separator]]:hidden",
        className,
      )}
      data-size={size}
      data-slot="toggle-group"
      data-variant={variant}
      orientation={orientation}
      {...props}
    >
      <ToggleGroupContext.Provider value={value}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  );
}

function Toggle({
  className,
  children,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);

  const resolvedVariant = variant ?? context.variant;
  const resolvedSize = size ?? context.size;

  return (
    <ToggleComponent
      className={className}
      data-size={resolvedSize}
      data-variant={resolvedVariant}
      size={resolvedSize}
      variant={resolvedVariant}
      {...props}
    >
      {children}
    </ToggleComponent>
  );
}

function ToggleGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: {
  className?: string;
} & React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn("pointer-events-none relative bg-border", className)}
      orientation={orientation}
      {...props}
    />
  );
}

export { ToggleGroup, Toggle, Toggle as ToggleGroupItem, ToggleGroupSeparator };
