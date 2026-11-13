import type { ReactNode } from "react";
import { Button } from "../ui/button";
export const FILE_SURFACE_SUBHEADER_CLASS =
  "flex h-10 shrink-0 items-center gap-2 border-b border-border px-3";

export function FileSurfaceAction(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </Button>
  );
}
export function FileSurfaceLoading() {
  return (
    <p role="status" className="p-4">
      Loading preview…
    </p>
  );
}
export function FileSurfaceNotice({ children }: { children: ReactNode }) {
  return (
    <p className="shrink-0 border-b border-border p-2 text-xs text-muted-foreground">{children}</p>
  );
}
export function FileSurfaceFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div role="alert" className="p-4">
      {message}
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  );
}
