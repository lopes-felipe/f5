import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { PopoverPopup } from "./popover";

// Keep the primitive boundary inline: Base UI portals don't render during SSR.
vi.mock("@base-ui/react/popover", async (importOriginal) => {
  const original = await importOriginal<typeof import("@base-ui/react/popover")>();
  const container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    ...original,
    Popover: {
      ...original.Popover,
      Portal: container,
      Positioner: container,
      Viewport: container,
      Popup: ({
        children,
        className,
        "data-slot": slot,
      }: {
        children: ReactNode;
        className?: string;
        "data-slot"?: string;
      }) => (
        <div className={className} data-slot={slot}>
          {children}
        </div>
      ),
    },
  };
});

it.each([false, true])(
  "keeps popovers interactive over desktop drag regions (tooltip=%s)",
  (tooltipStyle) => {
    const markup = renderToStaticMarkup(
      <PopoverPopup tooltipStyle={tooltipStyle} className="custom-popup">
        <button type="button">Select model</button>
      </PopoverPopup>,
    );
    const popup = /<div[^>]*data-slot="popover-popup"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(popup).toContain("[-webkit-app-region:no-drag]");
    expect(popup).toContain("custom-popup");
    expect(markup).toContain("Select model");
  },
);
