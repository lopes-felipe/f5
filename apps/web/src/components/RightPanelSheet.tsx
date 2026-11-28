import { useRef, type CSSProperties, type ReactNode } from "react";

import { isElectron } from "../env";
import { useRestoreFocusOnClose } from "../hooks/useRestoreFocusOnClose";
import {
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_TITLEBAR_HEIGHT_CSS_VAR,
} from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  useRestoreFocusOnClose({
    open: props.open,
    containerRef: popupRef,
  });

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        ref={popupRef}
        side="right"
        showCloseButton={false}
        keepMounted
        finalFocus={false}
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
        style={
          {
            [RIGHT_PANEL_TITLEBAR_HEIGHT_CSS_VAR]: isElectron
              ? "env(titlebar-area-height, 0px)"
              : "0px",
          } as CSSProperties
        }
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
