import { type CSSProperties, type ReactNode } from "react";

import { isElectron } from "../env";
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
        side="right"
        showCloseButton={false}
        keepMounted
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
