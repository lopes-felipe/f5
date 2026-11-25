export const BUILTIN_THEME_IDS = [
  "f5-black",
  "f5-black-classic",
  "f5-default",
  "f5-ocean",
  "f5-grove",
  "f5-ember",
  "f5-iris",
] as const;

/**
 * The user-overridable theme colors. The web app applies them as `--<name>`
 * CSS variables, and HTML renders receive the same names.
 */
export const THEME_TOKEN_NAMES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
] as const;
