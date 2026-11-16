import type { AnchorHTMLAttributes } from "react";
import { useOpenLink } from "../hooks/useOpenLink";
import { toastManager } from "./ui/toast";
export function OpenLinkAnchor({
  href,
  onClick,
  onAuxClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const open = useOpenLink();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !href || event.button !== 0) return;
        event.preventDefault();
        void open(href, {
          external: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        }).catch(() => toastManager.add({ type: "error", title: "Could not open link. Retry." }));
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        if (event.defaultPrevented || !href || event.button !== 1) return;
        event.preventDefault();
        void open(href, { external: true }).catch(() =>
          toastManager.add({ type: "error", title: "Could not open link. Retry." }),
        );
      }}
    />
  );
}
