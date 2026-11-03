import { PreviewCard as Primitive } from "@base-ui/react/preview-card";
import { cn } from "~/lib/utils";
import { usePopupOwnerAttributes } from "./popupFocus";
import { popupSurfaceClassName } from "./popupSurface";

export const PreviewCard = Primitive.Root;
export function PreviewCardTrigger({
  delay = 400,
  closeDelay = 150,
  ...props
}: Primitive.Trigger.Props) {
  return <Primitive.Trigger delay={delay} closeDelay={closeDelay} {...props} />;
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
          className={cn(popupSurfaceClassName, className)}
          {...ownerAttributes}
          {...props}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
