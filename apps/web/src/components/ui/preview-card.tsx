import { Popover as Primitive } from "@base-ui/react/popover";
import type { AnchorHTMLAttributes } from "react";
import { cn } from "~/lib/utils";
import { usePopupOwnerAttributes } from "./popupFocus";
import { popupSurfaceClassName } from "./popupSurface";

// Interactive previews need Popover's non-modal focus guards so Tab follows the
// trigger into the portal and then returns to the page's natural tab order.
export const PreviewCard = Primitive.Root;
export function PreviewCardTrigger({
  delay = 400,
  closeDelay = 150,
  ...props
}: Primitive.Trigger.Props &
  Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel">) {
  return (
    <Primitive.Trigger
      nativeButton={false}
      role="link"
      openOnHover
      delay={delay}
      closeDelay={closeDelay}
      {...props}
    />
  );
}
export function PreviewCardPopup({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: Primitive.Popup.Props & Pick<Primitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  const ownerAttributes = usePopupOwnerAttributes();
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionAvoidance={{ side: "flip", align: "shift" }}
        className="z-[130]"
      >
        <Primitive.Popup
          initialFocus={false}
          finalFocus={false}
          className={cn(popupSurfaceClassName, className)}
          {...ownerAttributes}
          {...props}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
