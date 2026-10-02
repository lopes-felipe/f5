import type { AnchorHTMLAttributes } from "react";
import { useOpenLink } from "../hooks/useOpenLink";
import { toastManager } from "./ui/toast";
export function OpenLinkAnchor({
  href,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const open = useOpenLink();
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          !href ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        void open(href).catch(() =>
          toastManager.add({ type: "error", title: "Could not open link. Retry." }),
        );
      }}
    />
  );
}
