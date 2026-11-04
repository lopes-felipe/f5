"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "~/lib/utils";

/**
 * Quiet tonal field (docs/design/direction.md): a borderless `secondary` fill
 * that takes a ring-coloured border and a canvas fill when focused. For
 * elements that are the field themselves (native `<input>`, `<select>`,
 * `<textarea>`); add size, padding and font classes at the call site.
 */
const fieldSurfaceClassName =
  "rounded-md border border-transparent bg-secondary text-foreground outline-none ring-ring/24 transition-[border-color,box-shadow,background-color] duration-(--duration-fast) placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/16 dark:aria-invalid:ring-destructive/24 disabled:opacity-64";

/**
 * The same field look for a wrapper around the real control (`has-*` states).
 * It does not dim when a child is disabled: a wrapper may hold several
 * controls that dim themselves. Single-control shells add
 * `singleFieldShellDisabledClassName`.
 */
const fieldShellClassName =
  "relative inline-flex w-full rounded-md border border-transparent bg-secondary text-base text-foreground ring-ring/24 transition-[border-color,box-shadow,background-color] duration-(--duration-fast) has-focus-visible:border-ring has-focus-visible:bg-background has-focus-visible:ring-[3px] has-aria-invalid:border-destructive/36 has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 dark:has-aria-invalid:ring-destructive/24 has-autofill:bg-foreground/4 dark:has-autofill:bg-foreground/8 sm:text-sm";

/** Dims a shell whose one control (unstyled itself) is disabled. */
const singleFieldShellDisabledClassName = "has-disabled:opacity-64";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
  nativeInput?: boolean;
};

function Input({
  className,
  size = "default",
  unstyled = false,
  nativeInput = false,
  ...props
}: InputProps) {
  const inputClassName = cn(
    "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-muted-foreground sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );

  return (
    <span
      className={
        cn(!unstyled && [fieldShellClassName, singleFieldShellDisabledClassName], className) ||
        undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {nativeInput ? (
        <input
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          {...props}
        />
      ) : (
        <InputPrimitive
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          {...props}
        />
      )}
    </span>
  );
}

export {
  Input,
  type InputProps,
  fieldShellClassName,
  fieldSurfaceClassName,
  singleFieldShellDisabledClassName,
};
